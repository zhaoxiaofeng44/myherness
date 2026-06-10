// SessionManager runs Claude Code as a child process and turns its
// stream-json output into a stream of structured events that the UI can
// consume. It also drives the policy engine, change tracker, and audit log.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

import { ChangeTracker, captureContents } from './changeTracker.js';
import { evaluateToolUse, getPolicy } from './policyEngine.js';
import {
  keyFor as memoryKeyFor,
  hashWorkdir,
  lookupHabit,
  shouldAutoApply,
} from './memoryEngine.js';
import { decideToolApproval, decideAskUserQuestion } from './memoryDecider.js';
import { relevantForPrompt } from './memoryRetriever.js';
import { GoalRunner, cleanGoalArtefacts } from './goalRunner.js';

let _id = 0;
const nextId = () => `s${Date.now().toString(36)}${(_id++).toString(36)}`;

const MAX_EVENTS = 5000;

export class SessionManager extends EventEmitter {
  constructor({ store, memoryStore, deciderQueue } = {}) {
    super();
    this.sessions = new Map();
    this.store = store || null;
    this.memoryStore = memoryStore || null;
    this.deciderQueue = deciderQueue || null;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => s.summary());
  }

  get(id) {
    return this.sessions.get(id);
  }

  create({ workdir, name, policyId, parentSessionId }) {
    let abs = path.resolve(workdir || process.cwd());
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    } else if (!fs.statSync(abs).isDirectory()) {
      throw new Error(`路径已存在但不是目录: ${abs}`);
    }
    // Resolve symlinks (e.g. /tmp -> /private/tmp on macOS) so paths the
    // CLI reports later match the workdir we record.
    try {
      abs = fs.realpathSync(abs);
    } catch {}
    // 同目录只允许一个项目。带 parentSessionId 的是「下一任务」，属于同项目追加任务，放行。
    if (!parentSessionId) {
      for (const existing of this.sessions.values()) {
        if (existing.workdir === abs) {
          throw new Error(`该目录已存在项目「${existing.name}」，同一目录只能创建一个项目`);
        }
      }
    }
    const parentId =
      parentSessionId && this.sessions.has(parentSessionId) ? parentSessionId : null;
    const resolvedPolicy = policyId || 'balanced';
    // Wipe stale .claude-goal/{task,plan,test}.md so the next run isn't
    // confused by leftovers from a previous goal. Two trigger conditions:
    //   (a) fresh YOLO session — clean before GoalRunner.start() so the user
    //       sees a clean slate immediately after creation.
    //   (b) "下一任务" flow (has parentSessionId) — even if the new session
    //       isn't YOLO, leftover plan/test markdown in the workdir would
    //       still leak into Claude's context and bias the next task.
    let cleanedGoalArtefacts = [];
    if (resolvedPolicy === 'yolo' || parentId) {
      cleanedGoalArtefacts = cleanGoalArtefacts(abs);
    }
    const session = new Session({
      id: nextId(),
      workdir: abs,
      name: name || path.basename(abs),
      policyId: resolvedPolicy,
      parentSessionId: parentId,
      bus: this,
    });
    session._store = this.store;
    session._memoryStore = this.memoryStore;
    session._deciderQueue = this.deciderQueue;
    session.changeTracker.takeSnapshot();
    if (cleanedGoalArtefacts.length > 0) {
      session._record({
        type: 'goal:cleanup',
        cleanedArtefacts: cleanedGoalArtefacts,
        when: 'session-create',
      });
    }
    this.sessions.set(session.id, session);
    this.emit('session:created', session.summary());
    this.store?.scheduleSave(session);
    return session;
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    // 同一项目（=同一 workdir）下的所有会话一起清理，避免遗留孤立的链节点。
    const projectDir = s.workdir;
    const siblings = [];
    for (const other of this.sessions.values()) {
      if (other.workdir === projectDir) siblings.push(other);
    }
    for (const target of siblings) {
      try { target.stop(); } catch {}
      this.sessions.delete(target.id);
      this.store?.remove(target.id);
      this.emit('session:removed', { id: target.id });
    }
    return true;
  }

  // Rebuild a Session from a persisted payload after a server restart.
  // Live-only fields (activeChild/activeTurn/pendingApprovals) are reset,
  // and a synthetic `session:interrupted` event is appended so the audit
  // log reflects the gap.
  hydrate(persisted) {
    const session = new Session({
      id: persisted.id,
      workdir: persisted.workdir,
      name: persisted.name,
      policyId: persisted.policyId,
      parentSessionId: persisted.parentSessionId || null,
      bus: this,
    });
    session._store = this.store;
    session._memoryStore = this.memoryStore;
    session._deciderQueue = this.deciderQueue;

    // Restore audit/state fields verbatim.
    session.createdAt = persisted.createdAt;
    session.endedAt = persisted.endedAt;
    session.claudeSessionId = persisted.claudeSessionId || null;
    session.turns = Array.isArray(persisted.turns) ? persisted.turns : [];
    session.events = Array.isArray(persisted.events) ? persisted.events : [];
    session.tools = Array.isArray(persisted.tools) ? persisted.tools : [];
    session.changes = Array.isArray(persisted.changes) ? persisted.changes : [];
    session.lastChangeMap = persisted.lastChangeMap || {};
    session.fileBaselines = persisted.fileBaselines || {};

    // Live fields are always fresh.
    session.activeChild = null;
    session.activeTurn = null;
    session.pendingApprovals = new Map();

    const workdirOk =
      fs.existsSync(persisted.workdir) && fs.statSync(persisted.workdir).isDirectory();
    if (workdirOk) {
      let status = persisted.status;
      if (status === 'running' || status === 'waiting' || status === 'cancelling') status = 'idle';
      session.status = status || 'idle';
    } else {
      session.status = 'error';
    }

    // Mark any approvals that were pending at shutdown as abandoned.
    if (Array.isArray(persisted.pendingApprovals)) {
      for (const a of persisted.pendingApprovals) {
        session._record({
          type: 'approval:abandoned',
          toolUseId: a.toolUseId || a.id,
          tool: a.tool,
        });
      }
    }

    if (!workdirOk) {
      session._record({ type: 'session:workdir-missing', workdir: persisted.workdir });
    }
    session._record({ type: 'session:interrupted' });

    this.sessions.set(session.id, session);
    this.emit('session:created', session.summary());
    return session;
  }
}

class Session {
  constructor({ id, workdir, name, policyId, parentSessionId, bus }) {
    this.id = id;
    this.workdir = workdir;
    this.name = name;
    this.policyId = policyId;
    this.parentSessionId = parentSessionId || null;
    this.bus = bus;

    this.createdAt = Date.now();
    this.endedAt = null;
    this.status = 'idle'; // idle | running | waiting | ended | error
    this.claudeSessionId = null;

    this.turns = []; // { id, prompt, startedAt, endedAt, status }
    this.events = []; // chronological log of EVERY event (audit log)
    this.tools = []; // tool_use audit records with policy decision
    this.changes = []; // per-turn change sets
    this.lastChangeMap = {}; // relPath -> { turn, kind }

    this.changeTracker = new ChangeTracker(workdir);
    this.fileBaselines = {}; // relPath -> content snapshot for diff display

    this.activeChild = null;
    this.activeTurn = null;
    this.pendingApprovals = new Map();
    this.goalRunner = null;
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      workdir: this.workdir,
      policyId: this.policyId,
      parentSessionId: this.parentSessionId || null,
      status: this.status,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      turnCount: this.turns.length,
      changeCount: this.changes.reduce((acc, c) => acc + c.files.length, 0),
      pendingApprovals: this.pendingApprovals.size,
      claudeSessionId: this.claudeSessionId,
      goal: this.goalRunner ? this.goalRunner.summary() : null,
    };
  }

  setPolicy(policyId) {
    this.policyId = policyId;
    this._record({ type: 'policy:changed', policyId });
  }

  // ===== Turn execution =====
  // opts.fromAUQ: 这一轮是 AUQ 回答自动接续而来的；前端聊天流靠这个标记
  // 跳过 turn:start 里的 user 气泡，避免和 approval:resolved 的回答回显重复。
  async sendPrompt(prompt, opts = {}) {
    if (this.activeChild) throw new Error('当前会话已有运行中的对话');

    // YOLO/Goal interception: when the user (not the GoalRunner itself) sends
    // a prompt under the `yolo` policy, treat it as the task description and
    // kick off the autonomous plan→dev→test→eval loop.
    if (this.policyId === 'yolo' && !opts.fromGoal) {
      if (this.goalRunner && this.goalRunner.status === 'active') {
        throw new Error('YOLO 闭环正在运行，请先停止或等待结束');
      }
      this.goalRunner = new GoalRunner(this, { task: prompt });
      return this.goalRunner.start();
    }

    const policy = getPolicy(this.policyId);
    const turnId = `t${this.turns.length + 1}`;
    const turn = {
      id: turnId,
      prompt,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      policyId: policy.id,
    };
    this.turns.push(turn);
    this.activeTurn = turn;

    this.status = 'running';
    this._record({ type: 'turn:start', turnId, prompt, policyId: policy.id, fromAUQ: !!opts.fromAUQ });
    this._broadcastSummary();

    // Take a snapshot before running so we can diff afterwards.
    this.changeTracker.takeSnapshot();

    const images = opts.images; // [{ base64, mimeType }] or undefined
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', policy.permissionMode,
    ];
    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }
    const augmented = this._buildAugmentedPrompt(prompt);
    const useStdin = Array.isArray(images) && images.length > 0;
    if (!useStdin) {
      args.push(augmented);
    }

    let child;
    try {
      child = spawn('claude', args, {
        cwd: this.workdir,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,
      });
      if (useStdin) {
        const stdinPayload = augmented + '\n\n[附带图片 ' + images.length + ' 张，图片数据已通过 base64 编码传递]';
        child.stdin.write(stdinPayload);
        child.stdin.end();
      }
    } catch (e) {
      this._record({ type: 'turn:error', turnId, error: e.message });
      turn.status = 'error';
      turn.endedAt = Date.now();
      this.status = 'error';
      this.activeTurn = null;
      this._broadcastSummary();
      throw e;
    }
    this.activeChild = child;
    this._cancelRequested = false;
    this._killedForPendingInput = false;
    if (this._killEscalateTimer) {
      clearTimeout(this._killEscalateTimer);
      this._killEscalateTimer = null;
    }

    // Pre-capture baselines for any files that may be edited so we can show
    // diffs even after Claude writes them.
    // We capture lazily on-demand from snapshot keys.

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) this._handleStreamLine(line);
      }
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    let turnFinished = false;
    child.on('error', (err) => {
      this._record({ type: 'turn:error', turnId, error: err.message });
      setTimeout(() => {
        if (!turnFinished) {
          turnFinished = true;
          this._afterTurnFinish('error');
        }
      }, 3000);
    });

    child.on('close', (code, signal) => {
      if (turnFinished) return;
      turnFinished = true;
      if (this._killEscalateTimer) {
        clearTimeout(this._killEscalateTimer);
        this._killEscalateTimer = null;
      }
      if (stdoutBuf.trim()) this._handleStreamLine(stdoutBuf.trim());
      // If the user clicked stop, mark the turn cancelled rather than errored —
      // a non-zero exit from a SIGTERM/SIGKILL is expected, not a real failure.
      let outcome;
      if (this._cancelRequested) outcome = 'cancelled';
      else if (this._killedForPendingInput) outcome = 'paused';
      else if (code === 0) outcome = 'done';
      else outcome = 'error';
      if (outcome === 'error' && stderrBuf) {
        this._record({ type: 'cli:stderr', text: stderrBuf.trim() });
      }
      this._afterTurnFinish(outcome, signal);
    });

    return turn;
  }

  cancel() {
    if (this.goalRunner && this.goalRunner.status === 'active') {
      this.goalRunner.abort('user-cancelled');
    }
    if (!this.activeChild) return false;
    if (this._cancelRequested) return true; // idempotent
    this._cancelRequested = true;
    this.status = 'cancelling';
    this._record({ type: 'turn:cancel', turnId: this.activeTurn?.id });
    this._broadcastSummary();
    this._signalChildGroup('SIGTERM');
    // Escalate to SIGKILL if the process group is still alive after 2.5s.
    // Cleared in child.on('close').
    this._killEscalateTimer = setTimeout(() => {
      if (this.activeChild) {
        this._signalChildGroup('SIGKILL');
      }
    }, 2500);
    return true;
  }

  _signalChildGroup(sig) {
    const child = this.activeChild;
    if (!child || child.pid == null) return;
    // Kill the whole process group (negative pid) so subprocesses go too.
    // Falls back to a direct kill if the group call fails (e.g. ESRCH means
    // the process is already gone — nothing to do).
    try {
      process.kill(-child.pid, sig);
    } catch (e) {
      if (e.code !== 'ESRCH') {
        try { child.kill(sig); } catch {}
      }
    }
  }

  stop() {
    this.cancel();
    if (this.status !== 'ended') {
      this.status = 'ended';
      this.endedAt = Date.now();
      this._record({ type: 'session:ended' });
      this._broadcastSummary();
    }
  }

  _handleStreamLine(line) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      this._record({ type: 'cli:rawline', text: line });
      return;
    }

    // Capture session id if provided.
    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      this.claudeSessionId = evt.session_id;
      this._broadcastSummary();
    }

    // Surface assistant text + tool uses.
    if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text) {
          this._record({
            type: 'assistant:text',
            turnId: this.activeTurn?.id,
            text: block.text,
          });
        } else if (block.type === 'tool_use') {
          this._handleToolUse(block);
        } else if (block.type === 'thinking' && block.thinking) {
          this._record({
            type: 'assistant:thinking',
            turnId: this.activeTurn?.id,
            text: block.thinking,
          });
        }
      }
    } else if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result') {
          this._record({
            type: 'tool:result',
            turnId: this.activeTurn?.id,
            tool_use_id: block.tool_use_id,
            isError: block.is_error || false,
            content: extractText(block.content),
          });
        }
      }
    } else if (evt.type === 'result') {
      this._record({
        type: 'turn:result',
        turnId: this.activeTurn?.id,
        subtype: evt.subtype,
        result: evt.result,
        durationMs: evt.duration_ms,
        usage: evt.usage,
        cost: evt.total_cost_usd,
      });
    } else if (evt.type === 'system') {
      // Forward as raw system event for inspectors.
      this._record({
        type: 'system',
        turnId: this.activeTurn?.id,
        subtype: evt.subtype,
        raw: evt,
      });
    } else {
      // Unknown — keep raw.
      this._record({ type: 'cli:event', raw: evt });
    }
  }

  _handleToolUse(block) {
    const policy = getPolicy(this.policyId);
    const decision = evaluateToolUse(policy, block, { workdir: this.workdir });

    // Path A: deterministic fast-path. If we have a high-confidence habit
    // (≥5 consistent approves with no rejects in the recent window), skip the
    // LLM decider entirely and resolve as if the user pre-approved.
    let memoryHint = null;
    let appliedFastPath = null;
    if (decision.decision === 'manual' && this._memoryStore?.entries?.length) {
      const wdHash = hashWorkdir(this.workdir);
      const { keySignature } = memoryKeyFor(block.name, block.input, this.workdir);
      const habit = lookupHabit(this._memoryStore.entries, { keySignature, workdirHash: wdHash });
      if (habit) {
        const counts = habit.counts || { approve: 0, reject: 0 };
        memoryHint = {
          entryId: habit.id,
          counts,
          lastDecision: habit.lastDecision,
          frozen: !!habit.frozen,
        };
        const verdict = shouldAutoApply(habit);
        if (verdict === 'approve' || verdict === 'reject') {
          decision.decision = verdict === 'approve' ? 'auto' : 'reject';
          decision.reason = `记忆命中（${counts.approve}✓/${counts.reject}✗，fast-path）：${decision.reason || ''}`;
          appliedFastPath = { entryId: habit.id, verdict, counts };
        }
      }
    }

    const record = {
      id: block.id,
      turnId: this.activeTurn?.id,
      tool: block.name,
      input: block.input,
      decision: decision.decision,
      reason: decision.reason,
      ruleMatched: decision.rule?.match || null,
      timestamp: Date.now(),
      memoryHint,
      deciderState: null, // 'pending' | 'decided' | 'uncertain' | 'cancelled' | 'error' | 'skipped'
    };
    this.tools.push(record);
    this._record({ type: 'tool:use', ...record });

    if (appliedFastPath) {
      this._record({
        type: 'memory:applied',
        path: 'fast',
        toolUseId: block.id,
        entryId: appliedFastPath.entryId,
        verdict: appliedFastPath.verdict,
        counts: appliedFastPath.counts,
      });
      return;
    }

    if (decision.decision !== 'manual') return;

    // Manual: queue the approval card.
    this.pendingApprovals.set(block.id, record);
    this._record({
      type: 'approval:pending',
      toolUseId: block.id,
      tool: block.name,
      input: block.input,
      reason: decision.reason,
      memoryHint,
    });
    this.status = 'waiting';
    this._broadcastSummary();

    // Path B: kick off async LLM decider if memory is available.
    this._maybeKickoffDecider(record);

    // AskUserQuestion / ExitPlanMode in --print (non-interactive) mode:
    // The CLI auto-cancels the tool (stdin is not interactive), Claude sees
    // "cancelled" and retries — looping until the context thrashes.
    // Kill the CLI immediately so the user can answer in the console UI;
    // the answer will be sent as a --resume follow-up via _queueAUQFollowUp.
    if (
      (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') &&
      this.activeChild
    ) {
      this._killedForPendingInput = true;
      this._signalChildGroup('SIGTERM');
      if (!this._killEscalateTimer) {
        this._killEscalateTimer = setTimeout(() => {
          if (this.activeChild) this._signalChildGroup('SIGKILL');
        }, 2500);
      }
    }
  }

  _maybeKickoffDecider(record) {
    if (!this._memoryStore || !this._deciderQueue) return;
    if (!Array.isArray(this._memoryStore.entries) || this._memoryStore.entries.length === 0) return;

    const turnId = record.turnId;
    const acquired = this._deciderQueue.acquire({
      sessionId: this.id,
      turnId,
      toolUseId: record.id,
    });
    if (!acquired.ok) {
      record.deciderState = 'skipped';
      this._record({
        type: 'memory:decider-skipped',
        toolUseId: record.id,
        reason: acquired.reason,
      });
      return;
    }

    record.deciderState = 'pending';
    this._record({
      type: 'memory:deciding',
      toolUseId: record.id,
      tool: record.tool,
    });

    const turn = this.activeTurn || this.turns.find((t) => t.id === turnId);
    const entries = this._memoryStore.entries;
    const sessionShape = this; // pass `this` — decider only reads workdir + policyId

    acquired.run(async (signal) => {
      try {
        let verdict;
        if (record.tool === 'AskUserQuestion') {
          verdict = await decideAskUserQuestion({
            entries, session: sessionShape, turn,
            input: record.input, signal,
          });
        } else {
          verdict = await decideToolApproval({
            entries, session: sessionShape, turn,
            tool: record.tool, input: record.input,
            decisionReason: record.reason, signal,
          });
        }
        return verdict;
      } catch (e) {
        return { error: e.message };
      }
    }).then((verdict) => this._handleDeciderResult(record, verdict))
      .catch((e) => this._handleDeciderResult(record, { error: e.message }));
  }

  _handleDeciderResult(record, verdict) {
    // The user may have cancelled, manually resolved, or the turn ended in
    // the meantime — bail if the approval is no longer pending.
    if (!this.pendingApprovals.has(record.id)) return;

    // 用户已点击「我自己决定」：哪怕 verdict 在飞行中已经算出结果，也不能
    // 覆盖人工接管 —— 保留 pending 状态，让用户继续手填答案。
    if (record.deciderState === 'cancelled') {
      this._record({
        type: 'memory:decision-discarded',
        toolUseId: record.id,
        reason: 'user-cancelled-before-verdict',
      });
      return;
    }

    if (!verdict || verdict.error || verdict.skipped) {
      record.deciderState = verdict?.skipped ? 'skipped' : 'error';
      this._record({
        type: verdict?.skipped ? 'memory:decider-skipped' : 'memory:decision-error',
        toolUseId: record.id,
        reason: verdict?.error || verdict?.skipped || 'unknown',
      });
      this._broadcastSummary();
      return;
    }

    const { decision, confidence, reason, usedMemoryIds } = verdict;
    const isAUQ = record.tool === 'AskUserQuestion';
    const expected = isAUQ
      ? collectAUQLabels(record.input)
      : ['approve', 'reject'];
    const isConfident = decision !== 'uncertain' && confidence >= 0.7 && expected.includes(decision);

    if (!isConfident) {
      record.deciderState = 'uncertain';
      record.deciderReason = reason || '';
      this._record({
        type: 'memory:decision-uncertain',
        toolUseId: record.id,
        confidence: confidence || 0,
        reason: reason || '',
        usedMemoryIds: usedMemoryIds || [],
      });
      this._broadcastSummary();
      return;
    }

    // Confident — auto-resolve.
    if (isAUQ) {
      const auqAnswers = synthesizeAUQAnswers(record.input, decision);
      // 没"具体选择"就不算自动作答。decider 的 label 没匹配上任何 option
      // 时（罕见但可能发生），落回人工等待，避免提交空答案直接关弹窗。
      if (auqAnswers.length === 0) {
        record.deciderState = 'uncertain';
        record.deciderReason = `记忆助手给出的答案「${decision}」未匹配到任何选项`;
        this._record({
          type: 'memory:decision-uncertain',
          toolUseId: record.id,
          confidence,
          reason: record.deciderReason,
          usedMemoryIds: usedMemoryIds || [],
        });
        this._broadcastSummary();
        return;
      }
      const synthesizedNote = `[记忆助手自动作答 confidence=${confidence.toFixed(2)}] ${decision}`;
      this._record({
        type: 'memory:decided',
        toolUseId: record.id,
        decision,
        confidence,
        reason: reason || '',
        usedMemoryIds: usedMemoryIds || [],
      });
      this.resolveApproval(record.id, 'auto', synthesizedNote, { auqAnswers });
    } else {
      const decisionResolved = decision === 'approve' ? 'auto' : 'reject';
      this._record({
        type: 'memory:decided',
        toolUseId: record.id,
        decision: decisionResolved,
        confidence,
        reason: reason || '',
        usedMemoryIds: usedMemoryIds || [],
      });
      this.resolveApproval(record.id, decisionResolved,
        `[记忆助手自动决定 confidence=${confidence.toFixed(2)}] ${reason || ''}`);
    }
  }

  // Build a prompt augmented with relevant experience memories. The original
  // prompt is preserved verbatim after the <memory> block so Claude can
  // distinguish guidance from the actual task.
  _buildAugmentedPrompt(prompt) {
    if (!this._memoryStore?.entries?.length) return prompt;
    let memos;
    try {
      const modifiedPaths = (this.changes || [])
        .flatMap((c) => (c.files || []).map((f) => f.relPath))
        .filter(Boolean);
      memos = relevantForPrompt(this._memoryStore.entries, {
        workdir: this.workdir,
        prompt,
        modifiedPaths,
      });
    } catch {
      return prompt;
    }
    if (!memos || memos.length === 0) return prompt;
    const block = memos.map((m) => `- 【${m.title}】 ${m.body}`).join('\n');
    this._record({
      type: 'prompt:augmented',
      injectedIds: memos.map((m) => m.id),
    });
    return `<memory>\n${block}\n</memory>\n\n${prompt}`;
  }

  // The user may resolve a pending manual approval from the UI. For普通工具
  // 而言这是审计性质（CLI 端已被 --permission-mode 决定）；对 AskUserQuestion
  // 则会把回答自动作为下一轮 prompt 发回 Claude，让任务接着走下去。
  resolveApproval(toolUseId, decision, note, extra = {}) {
    const rec = this.pendingApprovals.get(toolUseId);
    if (!rec) return false;
    this.pendingApprovals.delete(toolUseId);
    rec.decision = decision; // 'auto' (approved) | 'reject'
    rec.manualResolution = decision;
    rec.manualNote = note || '';
    const auqAnswers = extra && extra.auqAnswers;
    if (auqAnswers) rec.auqAnswers = auqAnswers;
    this._record({
      type: 'approval:resolved',
      toolUseId,
      decision,
      note: note || '',
      auqAnswers: auqAnswers ? auqAnswers : undefined,
    });
    if (this.pendingApprovals.size === 0 && this.status === 'waiting') {
      this.status = this.activeChild ? 'running' : 'idle';
    }
    this._broadcastSummary();

    // AskUserQuestion 接续：用户通过/记忆助手自动作答时，把回答当作下一轮
    // prompt 自动发送，触发 claude --resume 继续会话。reject 则不接续。
    if (rec.tool === 'AskUserQuestion' && decision === 'auto') {
      const hasPicks = Array.isArray(auqAnswers) && auqAnswers.length > 0;
      const hasNote = (note || '').trim().length > 0;
      if (hasPicks || hasNote) {
        this._queueAUQFollowUp({ auqAnswers: auqAnswers || [], note: note || '' });
      }
    }
    // ExitPlanMode 接续：用户确认计划后，自动发送继续指令让 Claude 开始执行。
    if (rec.tool === 'ExitPlanMode' && decision === 'auto') {
      this._queuePlanConfirmFollowUp(note || '');
    }
    return true;
  }

  _queueAUQFollowUp({ auqAnswers, note }) {
    // 多个 AUQ 同轮少见，但若发生只接续第一个回答，避免连发多个 prompt。
    if (this._pendingFollowUp) return;
    // submitAskUserQuestion 已把选项 + 自由输入 + 备注拼进 note；空时回退用
    // 结构化 auqAnswers 拼一份，确保 Claude 一定能收到具体内容。
    let body = (note || '').trim();
    if (!body && Array.isArray(auqAnswers)) {
      body = auqAnswers
        .map((a) => {
          const q = (a.question || '').trim() || '（无问题文本）';
          const picked = Array.isArray(a.picked) ? a.picked.filter(Boolean) : [];
          return `• ${q}\n  → ${picked.length ? picked.join(' / ') : '（未选）'}`;
        })
        .join('\n');
    }
    if (!body) return;
    // CLI 在非交互模式（stdin=ignore）会给 AskUserQuestion 自动塞一条
    // 「user cancelled / 非交互」的 tool_result，--resume 后 Claude 会先读到
    // 它、然后才读到我们追发的回答，于是误以为用户真的取消了。
    // 这里把回答包一层显式说明，盖过那条默认 tool_result。
    const prompt = [
      '我刚才在 AskUserQuestion 弹窗里实际给出了下面的回答（请忽略 CLI 在非交互模式下',
      '自动填充的「取消 / 未应答」tool_result，那是默认行为，不代表我的真实选择）：',
      '',
      body,
      '',
      '请基于上述回答继续之前的任务。',
    ].join('\n');

    if (this.activeChild) {
      // 当前轮还没退出（罕见——AUQ 多数情况下 CLI 已结束），落到 _afterTurnFinish 再发。
      this._pendingFollowUp = prompt;
    } else {
      // 异步发起新轮，避免在 resolveApproval 的同步调用栈里直接 spawn。
      setImmediate(() => {
        this.sendPrompt(prompt, { fromAUQ: true }).catch((e) => {
          this._record({ type: 'turn:error', error: 'AUQ 接续失败: ' + e.message });
        });
      });
    }
  }

  _queuePlanConfirmFollowUp(note) {
    if (this._pendingFollowUp) return;
    const feedback = (note || '').trim();
    const prompt = [
      '我已在 ExitPlanMode 弹窗里确认了你的计划（请忽略 CLI 在非交互模式下',
      '自动填充的「取消」tool_result，那是默认行为，不代表我的真实选择）。',
      feedback ? `\n补充意见：${feedback}\n` : '',
      '请开始按计划执行。',
    ].filter(Boolean).join('\n');

    if (this.activeChild) {
      this._pendingFollowUp = prompt;
    } else {
      setImmediate(() => {
        this.sendPrompt(prompt, { fromAUQ: true }).catch((e) => {
          this._record({ type: 'turn:error', error: 'ExitPlanMode 接续失败: ' + e.message });
        });
      });
    }
  }

  // Cancel an in-flight decider and let the user take over.
  cancelDecider(toolUseId) {
    if (!this._deciderQueue) return false;
    this._deciderQueue.cancel(toolUseId);
    const rec = this.pendingApprovals.get(toolUseId);
    if (rec) {
      rec.deciderState = 'cancelled';
      this._record({
        type: 'memory:decision-error',
        toolUseId,
        reason: 'user-cancelled',
      });
      this._broadcastSummary();
    }
    return true;
  }

  _afterTurnFinish(reason) {
    const turn = this.activeTurn;
    if (turn) {
      turn.status = reason;
      turn.endedAt = Date.now();
    }
    this.activeChild = null;

    // Compute file changes for the turn.
    // Wrapped in try-catch: diff failures must never block status broadcast.
    try {
      const changedFiles = this.changeTracker.diff();
      if (changedFiles.length > 0 && turn) {
        const MAX_DIFF_LINES = 5000;
        const MAX_DIFF_LINE_CHARS = 2000;
        const enriched = changedFiles.map((c) => {
          let beforeContent = this.fileBaselines[c.relPath] ?? null;
          let afterContent = null;
          if (c.kind !== 'deleted') {
            try {
              const r = this.changeTracker.readFile(c.relPath);
              afterContent = r.content;
            } catch {}
          }
          let diffLines = null;
          let diffTruncated = false;
          if (beforeContent != null || afterContent != null) {
            const raw = this.changeTracker.unifiedDiff(c.relPath, beforeContent || '', afterContent || '');
            if (raw.length > MAX_DIFF_LINES) {
              diffLines = raw.slice(0, MAX_DIFF_LINES);
              diffTruncated = true;
            } else {
              diffLines = raw;
            }
            for (const ln of diffLines) {
              if (typeof ln.text === 'string' && ln.text.length > MAX_DIFF_LINE_CHARS) {
                ln.text = ln.text.slice(0, MAX_DIFF_LINE_CHARS) + '… (truncated)';
                diffTruncated = true;
              }
            }
          }
          if (afterContent != null) this.fileBaselines[c.relPath] = afterContent;
          else delete this.fileBaselines[c.relPath];

          return {
            relPath: c.relPath,
            kind: c.kind,
            size: c.size,
            diff: diffLines,
            diffTruncated: diffTruncated || undefined,
          };
        });
        const changeSet = {
          turnId: turn.id,
          timestamp: Date.now(),
          files: enriched,
        };
        this.changes.push(changeSet);
        for (const f of enriched) {
          this.lastChangeMap[f.relPath] = { turnId: turn.id, kind: f.kind };
        }
        this._record({ type: 'turn:changes', turnId: turn.id, files: enriched });
      } else if (turn) {
        this._record({ type: 'turn:changes', turnId: turn.id, files: [] });
      }
    } catch (e) {
      if (turn) this._record({ type: 'turn:changes', turnId: turn.id, files: [], error: e.message });
    }

    if (turn) this._record({ type: 'turn:end', turnId: turn.id, status: turn.status });

    if (turn && this._deciderQueue) {
      try { this._deciderQueue.resetTurn(this.id, turn.id); } catch {}
    }

    this.activeTurn = null;
    this._killedForPendingInput = false;
    if (this.pendingApprovals.size > 0) {
      this.status = 'waiting';
    } else {
      this.status = reason === 'error' ? 'error' : 'idle';
    }
    this._broadcastSummary();

    // 排空 AUQ 接续：上一轮里用户回答的内容，作为新一轮 prompt 自动发出。
    // 仅在非 error 终态触发，避免上一轮失败后还硬接续。
    if (this._pendingFollowUp && reason !== 'error') {
      const p = this._pendingFollowUp;
      this._pendingFollowUp = null;
      setImmediate(() => {
        this.sendPrompt(p, { fromAUQ: true }).catch((e) => {
          this._record({ type: 'turn:error', error: 'AUQ 接续失败: ' + e.message });
        });
      });
    } else if (this._pendingFollowUp) {
      this._pendingFollowUp = null;
    }
  }

  _record(event) {
    const enriched = { id: randomUUID(), ts: Date.now(), ...event };
    this.events.push(enriched);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.bus.emit('session:event', { sessionId: this.id, event: enriched });
    this._store?.scheduleSave(this);
  }

  _broadcastSummary() {
    this.bus.emit('session:updated', this.summary());
  }
}

function collectAUQLabels(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  const out = [];
  for (const q of qs) {
    if (Array.isArray(q.options)) {
      for (const o of q.options) if (o.label) out.push(o.label);
    }
  }
  return out;
}

// When the decider picks a single label, build the auqAnswers payload that
// approval-commit/learn-side code expects. We assign the picked label to the
// first question containing it (handles single-question AUQ which is the
// dominant case).
function synthesizeAUQAnswers(input, pickedLabel) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  for (const q of qs) {
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.some((o) => o.label === pickedLabel)) {
      return [{ question: q.question || '', picked: [pickedLabel] }];
    }
  }
  return [];
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
      .join('\n');
  }
  return '';
}
