// memoryDistiller — invokes a one-shot `claude` call to extract qualitative
// "experience" memories from the events of a finished turn. Returns candidate
// experiences (NOT persisted — the user reviews them first).
import { runClaudeOneShot, extractJson } from './claudeRunner.js';
import { redactString } from './memoryEngine.js';

const MAX_TURN_LOG_BYTES = 12_000;

export async function distillExperiences({ session, turnId, guidance = '', signal, timeoutMs = 60_000 } = {}) {
  if (!session || !turnId) return { items: [], error: 'missing session/turnId' };
  const turn = session.turns?.find((t) => t.id === turnId);
  if (!turn) return { items: [], error: `turn ${turnId} not found` };

  const transcript = buildTranscript({ session, turnId });
  const prompt = buildPrompt({ session, turn, transcript, guidance });

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
    return { items: [], error: e.message };
  }

  const parsed = extractJson(result.text || '');
  if (!parsed || !Array.isArray(parsed.items)) {
    return { items: [], error: 'failed to parse JSON from model output', raw: result.text };
  }

  const items = parsed.items
    .filter((it) => it && typeof it === 'object' && it.title && it.body)
    .map((it) => ({
      title: redactString(String(it.title)).slice(0, 200),
      body: redactString(String(it.body)).slice(0, 4000),
      tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 10) : [],
      triggers: {
        tools: Array.isArray(it.triggers?.tools) ? it.triggers.tools.map(String).slice(0, 10) : [],
        pathGlobs: Array.isArray(it.triggers?.pathGlobs) ? it.triggers.pathGlobs.map(String).slice(0, 10) : [],
        keywords: Array.isArray(it.triggers?.keywords) ? it.triggers.keywords.map(String).slice(0, 20) : [],
      },
    }))
    .slice(0, 6);

  return { items, error: null, usage: result.usage, cost: result.cost };
}

function buildPrompt({ session, turn, transcript, guidance = '' }) {
  const guidanceBlock = guidance && guidance.trim()
    ? ['【用户指引】 优先围绕以下方向提炼经验，与之无关的可以省略：', redactString(guidance.trim()), '']
    : [];
  return [
    '你是经验提炼助手。下面是用户与 Claude Code 的一次任务会话日志（已脱敏）。',
    '请从中提炼可在未来复用的"经验记忆"。',
    '',
    '【输出要求】',
    '- 严格 JSON，不要 markdown 代码块包裹，不要任何解释文字。',
    '- 每条经验 ≤3 段、第一人称中文，聚焦：用户偏好 / 避坑要点 / 可复用思路。',
    '- 不要复述具体代码，要写出"为什么这样做、下次怎么做"。',
    '- 没有值得沉淀的内容时返回 {"items":[]}。',
    '',
    '【格式】',
    '{ "items": [',
    '  { "title": "...",',
    '    "body": "...",',
    '    "tags": ["..."],',
    '    "triggers": { "tools":["..."], "pathGlobs":["..."], "keywords":["..."] } },',
    '  ...',
    '] }',
    '',
    ...guidanceBlock,
    `【工程】 workdir=${session.workdir}  policy=${session.policyId}`,
    `【本轮提示】 ${redactString(String(turn.prompt || '').slice(0, 1000))}`,
    '【会话日志】',
    transcript,
    '',
    '现在请输出 JSON：',
  ].join('\n');
}

function buildTranscript({ session, turnId }) {
  const events = Array.isArray(session.events) ? session.events : [];
  const lines = [];
  let used = 0;
  for (const e of events) {
    if (e.turnId !== turnId) continue;
    let line = null;
    if (e.type === 'assistant:text') line = `[assistant] ${truncate(e.text, 500)}`;
    else if (e.type === 'tool:use') line = `[tool ${e.tool}] decision=${e.decision} reason=${truncate(e.reason || '', 80)} input=${truncate(JSON.stringify(e.input || {}), 200)}`;
    else if (e.type === 'tool:result') line = `[result] ${e.isError ? '(error) ' : ''}${truncate(e.content || '', 300)}`;
    else if (e.type === 'approval:resolved') line = `[approval] ${e.toolUseId} -> ${e.decision}${e.note ? ' note=' + truncate(e.note, 200) : ''}`;
    else if (e.type === 'turn:result' && e.result) line = `[final] ${truncate(e.result, 500)}`;
    else if (e.type === 'turn:changes' && Array.isArray(e.files) && e.files.length) {
      line = `[changes] ${e.files.map((f) => `${f.kind}:${f.relPath}`).join(', ')}`;
    }
    if (!line) continue;
    line = redactString(line);
    if (used + line.length > MAX_TURN_LOG_BYTES) {
      lines.push('… (日志已截断)');
      break;
    }
    used += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n') || '(空)';
}

function truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}
