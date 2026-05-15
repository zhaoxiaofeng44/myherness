// memoryDecider — given a manual approval point (tool call or AskUserQuestion),
// asks an independent `claude -p` instance to pick the option most consistent
// with the user's accumulated memory. Returns a strict verdict with confidence;
// the caller decides whether to act on it or escalate to the human.
import { runClaudeOneShot, extractJson } from './claudeRunner.js';
import { redactInput, redactString } from './memoryEngine.js';
import { relevantForDecision } from './memoryRetriever.js';

const DEFAULT_TIMEOUT_MS = 10_000;

// Decide for a normal tool approval (returns approve | reject | uncertain).
export async function decideToolApproval({
  entries, session, turn, tool, input, decisionReason, signal, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { habits, experiences } = relevantForDecision(entries, {
    workdir: session.workdir,
    tool,
    input,
    prompt: turn?.prompt,
  });

  if (habits.length === 0 && experiences.length === 0) {
    // Nothing to base a decision on — caller should skip the decider entirely.
    return { skipped: 'no-memory', habits: [], experiences: [] };
  }

  const prompt = buildToolPrompt({ session, turn, tool, input, decisionReason, habits, experiences });
  return runDecider({ prompt, session, signal, timeoutMs, habits, experiences,
    expected: ['approve', 'reject'] });
}

// Decide for an AskUserQuestion (returns one of the option labels, or uncertain).
export async function decideAskUserQuestion({
  entries, session, turn, input, signal, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { habits, experiences } = relevantForDecision(entries, {
    workdir: session.workdir,
    tool: 'AskUserQuestion',
    input,
    prompt: turn?.prompt,
  });
  // For AUQ we'll always invoke if any habit/experience exists OR if any
  // option appears in any past AUQ habit (best-effort relevance check).
  if (habits.length === 0 && experiences.length === 0) {
    return { skipped: 'no-memory', habits: [], experiences: [] };
  }

  const allLabels = collectOptionLabels(input);
  if (allLabels.length === 0) {
    return { skipped: 'no-options', habits: [], experiences: [] };
  }

  const prompt = buildAUQPrompt({ session, turn, input, habits, experiences });
  return runDecider({ prompt, session, signal, timeoutMs, habits, experiences,
    expected: allLabels });
}

async function runDecider({ prompt, session, signal, timeoutMs, habits, experiences, expected }) {
  let result;
  try {
    result = await runClaudeOneShot({
      prompt,
      cwd: session.workdir,
      permissionMode: 'plan',
      signal,
      timeoutMs,
    });
  } catch (e) {
    return { error: e.message, habits, experiences };
  }
  const parsed = extractJson(result.text || '');
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'unparseable JSON', raw: result.text, habits, experiences };
  }
  const decision = String(parsed.decision || '').trim();
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const reason = redactString(String(parsed.reason || '')).slice(0, 400);
  const usedMemoryIds = Array.isArray(parsed.usedMemoryIds)
    ? parsed.usedMemoryIds.map(String).slice(0, 10) : [];

  // Validate decision against expected set.
  let valid = false;
  if (decision === 'uncertain') valid = true;
  else if (Array.isArray(expected) && expected.includes(decision)) valid = true;

  if (!valid) {
    return {
      decision: 'uncertain', confidence: 0, reason: 'invalid decision: ' + decision,
      usedMemoryIds, habits, experiences,
    };
  }
  return { decision, confidence, reason, usedMemoryIds, habits, experiences,
    usage: result.usage, cost: result.cost };
}

function buildToolPrompt({ session, turn, tool, input, decisionReason, habits, experiences }) {
  const safeInput = redactInput(input);
  return [
    '你是用户的"决策助手"。Claude Code 想执行一个动作，工程策略要求人工确认。',
    '请基于下方"用户记忆"判断该动作是否符合用户习惯，输出严格 JSON：',
    '{"decision":"approve"|"reject"|"uncertain","confidence":0..1,"reason":"...","usedMemoryIds":["..."]}',
    '',
    '【判断原则】',
    '- 记忆与当前情境吻合且方向一致 → approve / reject，confidence 反映吻合程度。',
    '- 记忆少 / 互相矛盾 / 与情境不直接相关 → 必须返回 uncertain，不要猜。',
    '- 不要输出任何解释文字，只输出 JSON。',
    '',
    '【当前情境】',
    `工具：${tool}`,
    `输入：${truncate(JSON.stringify(safeInput), 800)}`,
    `策略要求人工确认的原因：${decisionReason || ''}`,
    `本轮 prompt：${truncate(turn?.prompt || '', 500)}`,
    '',
    '【相关习惯】',
    formatHabits(habits) || '（无）',
    '',
    '【相关经验】',
    formatExperiences(experiences) || '（无）',
    '',
    '现在请输出 JSON：',
  ].join('\n');
}

function buildAUQPrompt({ session, turn, input, habits, experiences }) {
  const labels = collectOptionLabels(input);
  return [
    '你是用户的"决策助手"。Claude Code 弹出了一个选择题，请基于用户记忆替他选择。',
    '输出严格 JSON：{"decision":"<label>"|"uncertain","confidence":0..1,"reason":"...","usedMemoryIds":["..."]}',
    '其中 <label> 必须从下方"选项 label"中精确选择一个。',
    '',
    '【判断原则】',
    '- 记忆里有明确偏好 → 选对应选项；否则返回 uncertain。',
    '- 不要输出 JSON 之外任何文字。',
    '',
    '【当前问题】',
    formatAUQ(input),
    '',
    '【可选 label】',
    labels.map((l) => `- ${l}`).join('\n'),
    '',
    '【相关习惯】',
    formatHabits(habits) || '（无）',
    '',
    '【相关经验】',
    formatExperiences(experiences) || '（无）',
    '',
    `本轮 prompt：${truncate(turn?.prompt || '', 400)}`,
    '',
    '现在请输出 JSON：',
  ].join('\n');
}

function formatHabits(habits) {
  return habits.map((h) => {
    const c = h.counts || {};
    const days = h.lastTs ? Math.round((Date.now() - h.lastTs) / 86400000) : '?';
    return `- id=${h.id} key=${h.keySignature} scope=${h.scope} ${c.approve || 0}✓/${c.reject || 0}✗ 上次 ${days} 天前${h.frozen ? '（已冻结）' : ''}`;
  }).join('\n');
}

function formatExperiences(exps) {
  return exps.map((e) => {
    return `- id=${e.id} title="${redactString(e.title || '')}"\n  ${truncate(redactString(e.body || ''), 400)}`;
  }).join('\n');
}

function formatAUQ(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const optLines = opts.map((o) => `  · ${o.label}: ${o.description || ''}`).join('\n');
    return `Q${i + 1}: ${q.question}${q.multiSelect ? '（可多选）' : ''}\n${optLines}`;
  }).join('\n');
}

function collectOptionLabels(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  const labels = [];
  for (const q of qs) {
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (o.label && typeof o.label === 'string') labels.push(o.label);
      }
    }
  }
  return labels;
}

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}
