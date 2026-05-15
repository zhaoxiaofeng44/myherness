// deciderQueue — bounds the cost/concurrency of LLM-based decision calls.
// The console can run many sessions; an unhinged Claude could fire dozens of
// tool calls per turn. We protect against that with two limits:
//   - per-turn cap: refuses to invoke the decider after N calls in one turn
//   - global concurrency: at most M in-flight decider promises across sessions

const DEFAULT_GLOBAL_CONCURRENCY = 3;
const DEFAULT_PER_TURN_CAP = 20;

export class DeciderQueue {
  constructor({ globalConcurrency = DEFAULT_GLOBAL_CONCURRENCY, perTurnCap = DEFAULT_PER_TURN_CAP } = {}) {
    this.globalConcurrency = globalConcurrency;
    this.perTurnCap = perTurnCap;
    this._inFlight = 0;
    this._queue = []; // {fn, resolve, reject}
    this._turnCounts = new Map(); // `${sessionId}|${turnId}` -> count
    this._abortControllers = new Map(); // toolUseId -> AbortController
  }

  // Returns:
  //   { ok: true, run(fn): Promise }    — caller may run
  //   { ok: false, reason: 'quota' }    — per-turn quota exhausted
  acquire({ sessionId, turnId, toolUseId }) {
    const key = `${sessionId}|${turnId}`;
    const cur = this._turnCounts.get(key) || 0;
    if (cur >= this.perTurnCap) {
      return { ok: false, reason: 'quota' };
    }
    this._turnCounts.set(key, cur + 1);
    return {
      ok: true,
      run: (fn) => this._enqueue(fn, toolUseId),
    };
  }

  _enqueue(fn, toolUseId) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject, toolUseId });
      this._drain();
    });
  }

  _drain() {
    while (this._inFlight < this.globalConcurrency && this._queue.length > 0) {
      const job = this._queue.shift();
      this._inFlight++;
      const ac = new AbortController();
      if (job.toolUseId) this._abortControllers.set(job.toolUseId, ac);
      Promise.resolve()
        .then(() => job.fn(ac.signal))
        .then((v) => job.resolve(v), (e) => job.reject(e))
        .finally(() => {
          this._inFlight--;
          if (job.toolUseId) this._abortControllers.delete(job.toolUseId);
          this._drain();
        });
    }
  }

  // External cancellation (user clicked "我自己决定").
  cancel(toolUseId) {
    const ac = this._abortControllers.get(toolUseId);
    if (ac) ac.abort();
    // Remove pending queue entries for the same toolUseId.
    this._queue = this._queue.filter((j) => {
      if (j.toolUseId === toolUseId) {
        j.reject(new Error('user-cancelled'));
        return false;
      }
      return true;
    });
  }

  // Called when a turn ends — frees the per-turn counter so it can be reused
  // (no actual benefit since IDs are unique, but keeps the map bounded).
  resetTurn(sessionId, turnId) {
    this._turnCounts.delete(`${sessionId}|${turnId}`);
  }

  abortAll() {
    for (const ac of this._abortControllers.values()) {
      try { ac.abort(); } catch {}
    }
    this._abortControllers.clear();
    for (const j of this._queue) j.reject(new Error('shutdown'));
    this._queue = [];
  }
}
