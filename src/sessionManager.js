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

  create({ workdir, name, policyId }) {
    let abs = path.resolve(workdir || process.cwd());
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`工作目录不存在: ${abs}`);
    }
    // Resolve symlinks (e.g. /tmp -> /private/tmp on macOS) so paths the
    // CLI reports later match the workdir we record.
    try {
      abs = fs.realpathSync(abs);
    } catch {}
    const session = new Session({
      id: nextId(),
      workdir: abs,
      name: name || path.basename(abs),
      policyId: policyId || 'balanced',
      bus: this,
    });
    session._store = this.store;
    session._memoryStore = this.memoryStore;
    session._deciderQueue = this.deciderQueue;
    this.sessions.set(session.id, session);
    this.emit('session:created', session.summary());
    this.store?.scheduleSave(session);
    return session;
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.stop();
    this.sessions.delete(id);
    this.store?.remove(id);
    this.emit('session:removed', { id });
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
      // Re-snapshot so the next turn diffs against the post-restart state.
      session.changeTracker.takeSnapshot();
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
  constructor({ id, workdir, name, policyId, bus }) {
    this.id = id;
    this.workdir = workdir;
    this.name = name;
    this.policyId = policyId;
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
    this.changeTracker.takeSnapshot();
    this.fileBaselines = {}; // relPath -> content snapshot for diff display

    this.activeChild = null;
    this.activeTurn = null;
    this.pendingApprovals = new Map();
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      workdir: this.workdir,
      policyId: this.policyId,
      status: this.status,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      turnCount: this.turns.length,
      changeCount: this.changes.reduce((acc, c) => acc + c.files.length, 0),
      pendingApprovals: this.pendingApprovals.size,
      claudeSessionId: this.claudeSessionId,
    };
  }

  setPolicy(policyId) {
    this.policyId = policyId;
    this._record({ type: 'policy:changed', policyId });
  }

  // ===== Turn execution =====
  async sendPrompt(prompt) {
    if (this.activeChild) throw new Error('当前会话已有运行中的对话');
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
    this._record({ type: 'turn:start', turnId, prompt, policyId: policy.id });
    this._broadcastSummary();

    // Take a snapshot before running so we can diff afterwards.
    this.changeTracker.takeSnapshot();

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
    args.push(augmented);

    let child;
    try {
      // detached: true makes the child a process-group leader, so a single
      // process.kill(-pid, sig) tears down `claude` and any tool subprocesses
      // (Bash, MCP servers, etc.) it spawned. Without this, only the immediate
      // child dies and the user sees "停止" do nothing because Bash keeps
      // running in the background.
      child = spawn('claude', args, {
        cwd: this.workdir,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
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

    child.on('error', (err) => {
      this._record({ type: 'turn:error', turnId, error: err.message });
      this._endTurn('error', err.message);
    });

    child.on('close', (code, signal) => {
      if (this._killEscalateTimer) {
        clearTimeout(this._killEscalateTimer);
        this._killEscalateTimer = null;
      }
      if (stdoutBuf.trim()) this._handleStreamLine(stdoutBuf.trim());
      // If the user clicked stop, mark the turn cancelled rather than errored —
      // a non-zero exit from a SIGTERM/SIGKILL is expected, not a real failure.
      let outcome;
      if (this._cancelRequested) outcome = 'cancelled';
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
      const synthesizedNote = `[记忆助手自动作答 confidence=${confidence.toFixed(2)}] ${decision}`;
      const auqAnswers = synthesizeAUQAnswers(record.input, decision);
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

  // The user may resolve a pending manual approval from the UI. Because the
  // CLI already executed (or was prevented) by --permission-mode, this resolve
  // is informational/audit-only. We still track it so the UX is honest.
  resolveApproval(toolUseId, decision, note, extra = {}) {
    const rec = this.pendingApprovals.get(toolUseId);
    if (!rec) return false;
    this.pendingApprovals.delete(toolUseId);
    rec.decision = decision; // 'auto' (approved) | 'reject'
    rec.manualResolution = decision;
    rec.manualNote = note || '';
    if (extra && extra.auqAnswers) rec.auqAnswers = extra.auqAnswers;
    this._record({
      type: 'approval:resolved',
      toolUseId,
      decision,
      note: note || '',
      auqAnswers: extra && extra.auqAnswers ? extra.auqAnswers : undefined,
    });
    if (this.pendingApprovals.size === 0 && this.status === 'waiting') {
      this.status = this.activeChild ? 'running' : 'idle';
    }
    this._broadcastSummary();
    return true;
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
    const changedFiles = this.changeTracker.diff();
    if (changedFiles.length > 0 && turn) {
      const enriched = changedFiles.map((c) => {
        let beforeContent = this.fileBaselines[c.relPath] ?? null;
        let afterContent = null;
        if (c.kind !== 'deleted') {
          const r = this.changeTracker.readFile(c.relPath);
          afterContent = r.content;
        }
        let diffLines = null;
        if (beforeContent != null || afterContent != null) {
          diffLines = this.changeTracker.unifiedDiff(c.relPath, beforeContent || '', afterContent || '');
        }
        // Update baseline for next turn.
        if (afterContent != null) this.fileBaselines[c.relPath] = afterContent;
        else delete this.fileBaselines[c.relPath];

        return {
          relPath: c.relPath,
          kind: c.kind,
          size: c.size,
          diff: diffLines,
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

    if (turn) this._record({ type: 'turn:end', turnId: turn.id, status: turn.status });

    if (turn && this._deciderQueue) {
      this._deciderQueue.resetTurn(this.id, turn.id);
    }

    this.activeTurn = null;
    this.status = reason === 'error' ? 'error' : 'idle';
    this._broadcastSummary();
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
