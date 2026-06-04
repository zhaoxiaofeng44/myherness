// GoalRunner — drives the "goal mode" autonomous loop on top of a Session.
// Workflow per task:
//   1. planning    — ask Claude to (a) create .claude-goal/{task,plan,test}.md
//                    in the project, then (b) summarize the plan back.
//   2. developing  — execute plan.md with max permissions until it reports done.
//   3. testing     — run the checks described in test.md and report PASS/FAIL.
//      • FAIL  -> back to developing with the failure detail injected.
//      • PASS  -> go to evaluating.
//   4. evaluating  — judge whether the implementation actually meets the
//                    final goal described in task.md.
//      • not met -> back to developing with the gap detail injected.
//      • met     -> done.
//
// Phase transitions are inferred from the assistant's final text plus a small
// machine-readable JSON tail we ask the model to append. To keep the loop from
// running forever we cap total iterations.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const GLOBAL_PROMPT_FILE = path.join(os.homedir(), '.claude-console', 'goal-prompts.json');
const PROJECT_PROMPT_REL = path.join('.claude-goal', 'prompts.json');
const GOAL_DIR_REL = '.claude-goal';
// Per-task artefacts that get cleaned out on each new YOLO entry so a fresh
// run starts from a blank slate. prompts.json is the persistent user-editable
// guidance file and is explicitly preserved.
const GOAL_ARTEFACT_FILES = ['task.md', 'plan.md', 'test.md'];

// Stand-alone helper so callers outside of GoalRunner (notably session
// creation) can also wipe stale per-task artefacts. Returns the list of files
// actually removed so callers can log it.
export function cleanGoalArtefacts(workdir) {
  const cleaned = [];
  try {
    const dir = path.join(workdir, GOAL_DIR_REL);
    if (!fs.existsSync(dir)) return cleaned;
    for (const name of GOAL_ARTEFACT_FILES) {
      const f = path.join(dir, name);
      try {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
          fs.unlinkSync(f);
          cleaned.push(name);
        }
      } catch {}
    }
  } catch {}
  return cleaned;
}

const DEFAULT_MAX_ITERATIONS = 12;

const PHASE_LABELS = {
  planning: '规划中',
  developing: '开发中',
  testing: '测试中',
  evaluating: '评估中',
  done: '已完成',
  failed: '已停止',
};

function readGuidanceFile(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return '';
    // Accept JSON `{ "guidance": "..." }` (preferred), or fall back to the raw
    // file as a plain-text guidance block so users can drop ad-hoc notes in.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.guidance === 'string') return parsed.guidance.trim();
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      return raw;
    }
  } catch {}
  return '';
}

// Combine the two layers of user customisations. Global comes first, project
// overrides/augments. Either or both may be empty.
function loadCustomGuidance(workdir) {
  const globalText = readGuidanceFile(GLOBAL_PROMPT_FILE);
  const projectText = readGuidanceFile(path.join(workdir, PROJECT_PROMPT_REL));
  const blocks = [];
  if (globalText) blocks.push(`【全局偏好】\n${globalText}`);
  if (projectText) blocks.push(`【项目偏好】\n${projectText}`);
  return blocks.join('\n\n');
}

// Build the planning-phase prompt. Asks Claude to materialise three files
// inside the project's `.claude-goal/` directory and then summarise the plan
// back so we can record it in the audit log.
function buildPlanningPrompt({ task, guidance }) {
  const guidanceBlock = guidance
    ? `\n\n# 用户偏好（请在生成内容时遵循）\n${guidance}\n`
    : '';
  return [
    '# Goal 模式：规划阶段',
    '',
    '请在工作目录下创建 `.claude-goal/` 目录（若已存在则复用），然后写入以下三个文件：',
    '',
    '1. `.claude-goal/task.md` — 用简洁的语言重述用户的任务诉求，并在末尾用 `## 最终目标` 小节列出可验证的完成判据（结果是什么样、能跑通什么、用户能看到什么）。',
    '2. `.claude-goal/plan.md` — 把任务拆成有序的开发步骤，每一步写清楚要改哪些文件/模块、为什么这么改；对外部依赖、风险或不确定点要单独说明。',
    '3. `.claude-goal/test.md` — 列出验证清单：可以是自动化测试命令、手动验证步骤、关键日志/UI 现象。每一条都要能被独立判定为 PASS 或 FAIL。',
    '',
    '生成完毕后，请在回复正文里简要总结（不超过 5 行）你的计划与测试思路。',
    '',
    '在回复**末尾**追加一行严格的 JSON（独占一行，不要包在代码块里）：',
    '```',
    '{"goal_phase":"planning","status":"ready"}',
    '```',
    guidanceBlock,
    '',
    '# 用户任务',
    task,
  ].join('\n');
}

function buildDevelopmentPrompt({ feedback, iteration }) {
  const intro = feedback
    ? `# Goal 模式：开发阶段（第 ${iteration} 次迭代，根据上轮反馈继续）`
    : `# Goal 模式：开发阶段（第 ${iteration} 次迭代）`;
  const feedbackBlock = feedback
    ? `\n## 上一轮反馈\n${feedback}\n\n请优先解决上面提到的问题，必要时回看 \`.claude-goal/plan.md\` 与 \`.claude-goal/task.md\` 调整方案。\n`
    : '\n请按照 `.claude-goal/plan.md` 中尚未完成的步骤继续推进；若 plan 已全部完成请直接说明并进入收尾。\n';
  return [
    intro,
    feedbackBlock,
    '完成当前一轮工作后，在回复末尾追加一行严格 JSON：',
    '```',
    '{"goal_phase":"developing","status":"ready_for_test"}',
    '```',
    '若你判断当前迭代受阻无法继续（例如依赖缺失、需要外部信息），请把 status 设为 "blocked" 并在正文里说明阻塞原因。',
  ].join('\n');
}

function buildTestingPrompt({ iteration }) {
  return [
    `# Goal 模式：测试阶段（第 ${iteration} 次迭代）`,
    '',
    '请逐条执行 `.claude-goal/test.md` 中的验证项，每条独立给出 PASS/FAIL 以及证据（命令输出、文件片段、截图描述等）。',
    '若验证需要执行命令请直接执行；若需要的文件不存在或命令缺失，记作 FAIL 并说明原因。',
    '',
    '在正文末尾追加一行严格 JSON：',
    '```',
    '{"goal_phase":"testing","status":"pass"}',
    '```',
    '若有任何一项 FAIL，把 status 改为 "fail"，并把所有失败项汇总到一个 `failures` 字段里：',
    '```',
    '{"goal_phase":"testing","status":"fail","failures":["..."]}',
    '```',
  ].join('\n');
}

function buildEvaluationPrompt({ iteration }) {
  return [
    `# Goal 模式：评估阶段（第 ${iteration} 次迭代）`,
    '',
    '请对照 `.claude-goal/task.md` 中的「最终目标」，独立判断当前代码与已完成动作是否真正达成了用户任务（不要只看测试是否通过，要看目标是否被满足）。',
    '可以重新读取关键文件、执行轻量验证，但不要进行新的修改。',
    '',
    '在正文末尾追加一行严格 JSON：',
    '```',
    '{"goal_phase":"evaluating","status":"met"}',
    '```',
    '若未达成请把 status 改为 "not_met" 并说明缺口：',
    '```',
    '{"goal_phase":"evaluating","status":"not_met","gaps":["..."]}',
    '```',
  ].join('\n');
}

// Pull the last well-formed `{"goal_phase":...}` JSON object out of the
// assistant text. We tolerate code-fence wrapping and trailing whitespace.
function parsePhaseTail(text) {
  if (!text) return null;
  const fenced = text.match(/\{\s*"goal_phase"[\s\S]*?\}/g);
  if (!fenced || fenced.length === 0) return null;
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(fenced[i]);
      if (obj && typeof obj === 'object' && obj.goal_phase) return obj;
    } catch {}
  }
  return null;
}

export class GoalRunner {
  constructor(session, { task, maxIterations = DEFAULT_MAX_ITERATIONS } = {}) {
    this.session = session;
    this.task = String(task || '').trim();
    this.maxIterations = maxIterations;
    this.phase = 'planning';
    this.iteration = 0;
    this.status = 'active'; // 'active' | 'done' | 'failed' | 'aborted'
    this.lastTestFailures = null;
    this.lastEvalGaps = null;
    this.lastReason = '';
    this.guidance = loadCustomGuidance(session.workdir);
    this._unsubscribe = null;
    this._lastHandledTurnId = null;
  }

  summary() {
    return {
      active: this.status === 'active',
      phase: this.phase,
      phaseLabel: PHASE_LABELS[this.phase] || this.phase,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      status: this.status,
      reason: this.lastReason,
      task: this.task,
    };
  }

  start() {
    const cleaned = this._prepareGoalDir();
    this._record('goal:start', {
      task: this.task,
      guidanceLoaded: Boolean(this.guidance),
      maxIterations: this.maxIterations,
      cleanedArtefacts: cleaned,
    });
    this._attachListener();
    const prompt = buildPlanningPrompt({ task: this.task, guidance: this.guidance });
    return this.session.sendPrompt(prompt, { fromGoal: true });
  }

  abort(reason = 'aborted') {
    if (this.status !== 'active') return;
    this.status = 'aborted';
    this.lastReason = reason;
    this._detachListener();
    this._record('goal:aborted', { reason });
  }

  // Make sure the project's .claude-goal/ exists and clear out stale per-task
  // artefacts from a previous YOLO run. prompts.json (user-editable guidance)
  // is intentionally preserved.
  _prepareGoalDir() {
    try {
      const dir = path.join(this.session.workdir, GOAL_DIR_REL);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this._record('goal:warning', { message: `准备 .claude-goal 目录失败：${e.message}` });
    }
    return cleanGoalArtefacts(this.session.workdir);
  }

  _attachListener() {
    const handler = (payload) => {
      if (!payload || payload.sessionId !== this.session.id) return;
      const evt = payload.event;
      if (!evt || evt.type !== 'turn:end') return;
      if (this.status !== 'active') return;
      if (this._lastHandledTurnId === evt.turnId) return;
      this._lastHandledTurnId = evt.turnId;
      // Defer so audit listeners observe `turn:end` before our follow-up turn fires.
      setImmediate(() => this._onTurnEnd(evt));
    };
    this._unsubscribe = handler;
    this.session.bus.on('session:event', handler);
  }

  _detachListener() {
    if (this._unsubscribe) {
      this.session.bus.off('session:event', this._unsubscribe);
      this._unsubscribe = null;
    }
  }

  _record(type, data = {}) {
    this.session._record({
      type,
      goalPhase: this.phase,
      iteration: this.iteration,
      status: this.status,
      ...data,
    });
  }

  _broadcast() {
    this.session._broadcastSummary();
  }

  _lastAssistantTextForTurn(turnId) {
    const events = this.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'assistant:text' && e.turnId === turnId && e.text) {
        return e.text;
      }
    }
    return '';
  }

  _onTurnEnd(evt) {
    if (this.status !== 'active') return;
    // If the turn errored or was cancelled, halt the loop — the user can
    // restart manually rather than have us hammer a broken environment.
    if (evt.status && evt.status !== 'done') {
      this.status = 'failed';
      this.lastReason = `轮次以 ${evt.status} 结束，自动停止 Goal 闭环`;
      this._record('goal:failed', { reason: this.lastReason });
      this._detachListener();
      this._broadcast();
      return;
    }

    const text = this._lastAssistantTextForTurn(evt.turnId);
    const tail = parsePhaseTail(text);

    switch (this.phase) {
      case 'planning':
        return this._afterPlanning(tail);
      case 'developing':
        return this._afterDevelopment(tail);
      case 'testing':
        return this._afterTesting(tail);
      case 'evaluating':
        return this._afterEvaluation(tail);
      default:
        return;
    }
  }

  _afterPlanning(tail) {
    if (!tail || tail.status !== 'ready') {
      this._record('goal:warning', {
        message: '规划阶段未读到预期的 ready 标记，仍按计划进入开发阶段',
      });
    }
    this.phase = 'developing';
    this.iteration = 1;
    this._record('goal:phase', { phase: this.phase });
    this._broadcast();
    this._sendDevelopment(null);
  }

  _afterDevelopment(tail) {
    if (tail && tail.status === 'blocked') {
      this.status = 'failed';
      this.lastReason = '开发阶段被模型标记为 blocked，已暂停 Goal 闭环';
      this._record('goal:failed', { reason: this.lastReason });
      this._detachListener();
      this._broadcast();
      return;
    }
    this.phase = 'testing';
    this._record('goal:phase', { phase: this.phase });
    this._broadcast();
    this._sendTesting();
  }

  _afterTesting(tail) {
    if (!tail || tail.status !== 'pass') {
      this.lastTestFailures = (tail && Array.isArray(tail.failures))
        ? tail.failures.slice(0, 20)
        : ['未读到结构化测试结果，按 FAIL 处理'];
      this._record('goal:test-fail', { failures: this.lastTestFailures });
      return this._loopBackToDevelopment({
        kind: 'test',
        items: this.lastTestFailures,
      });
    }
    this.lastTestFailures = null;
    this._record('goal:test-pass');
    this.phase = 'evaluating';
    this._record('goal:phase', { phase: this.phase });
    this._broadcast();
    this._sendEvaluation();
  }

  _afterEvaluation(tail) {
    if (tail && tail.status === 'met') {
      this.status = 'done';
      this.phase = 'done';
      this.lastReason = '评估通过，目标已达成';
      this._record('goal:done', { reason: this.lastReason });
      this._detachListener();
      this._broadcast();
      return;
    }
    this.lastEvalGaps = (tail && Array.isArray(tail.gaps))
      ? tail.gaps.slice(0, 20)
      : ['评估未明确通过，按未达成处理'];
    this._record('goal:eval-fail', { gaps: this.lastEvalGaps });
    return this._loopBackToDevelopment({
      kind: 'eval',
      items: this.lastEvalGaps,
    });
  }

  _loopBackToDevelopment({ kind, items }) {
    if (this.iteration >= this.maxIterations) {
      this.status = 'failed';
      this.lastReason = `已达到最大迭代次数 ${this.maxIterations}，仍未通过 ${kind === 'test' ? '测试' : '评估'}`;
      this._record('goal:failed', { reason: this.lastReason });
      this._detachListener();
      this._broadcast();
      return;
    }
    this.phase = 'developing';
    this.iteration += 1;
    const heading = kind === 'test' ? '测试未通过项' : '评估未达成项';
    const feedback = `${heading}：\n- ${items.join('\n- ')}`;
    this._record('goal:phase', { phase: this.phase, reason: `${kind}-fail-feedback` });
    this._broadcast();
    this._sendDevelopment(feedback);
  }

  _sendDevelopment(feedback) {
    const prompt = buildDevelopmentPrompt({ feedback, iteration: this.iteration });
    this._queue(prompt);
  }

  _sendTesting() {
    const prompt = buildTestingPrompt({ iteration: this.iteration });
    this._queue(prompt);
  }

  _sendEvaluation() {
    const prompt = buildEvaluationPrompt({ iteration: this.iteration });
    this._queue(prompt);
  }

  _queue(prompt) {
    // sendPrompt asserts no active child, so wait one tick after turn:end has
    // fully cleared the session.activeChild reference.
    setImmediate(() => {
      if (this.status !== 'active') return;
      this.session.sendPrompt(prompt, { fromGoal: true }).catch((e) => {
        this.status = 'failed';
        this.lastReason = `发送下一阶段 prompt 失败：${e.message}`;
        this._record('goal:failed', { reason: this.lastReason });
        this._detachListener();
        this._broadcast();
      });
    });
  }
}

export const GOAL_PROMPT_PATHS = {
  global: GLOBAL_PROMPT_FILE,
  projectRel: PROJECT_PROMPT_REL,
};
