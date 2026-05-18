// SessionStore — owns all on-disk persistence of Session state.
// Single-writer assumption: only one process should manage a given data dir.
// Running two `node server.js` against the same dir will clobber writes.
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const DEBOUNCE_MS = 200;
const MAX_BASELINE_SIZE = 200_000;

export class SessionStore {
  constructor({ dir }) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._timers = new Map(); // id -> Timeout
  }

  loadAll() {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const full = path.join(this.dir, e.name);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const payload = JSON.parse(raw);
        if (this._validate(payload)) {
          out.push(payload);
        } else {
          this._markCorrupt(full);
        }
      } catch {
        this._markCorrupt(full);
      }
    }
    return out;
  }

  scheduleSave(session) {
    const id = session.id;
    if (this._timers.has(id)) return;
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this._writeSession(session);
    }, DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.set(id, timer);
  }

  saveNow(session) {
    const t = this._timers.get(session.id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(session.id);
    }
    this._writeSession(session);
  }

  flushAll(manager) {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    for (const session of manager.sessions.values()) {
      try {
        this._writeSession(session);
      } catch (e) {
        console.error(`[sessionStore] flush failed ${session.id}:`, e.message);
      }
    }
  }

  remove(id) {
    const t = this._timers.get(id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(id);
    }
    const file = path.join(this.dir, `${id}.json`);
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`[sessionStore] unlink failed ${id}:`, e.message);
      }
    }
  }

  _writeSession(session) {
    const payload = serialize(session);
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[sessionStore] write failed ${session.id}:`, e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  _validate(payload) {
    return (
      payload &&
      payload.version === VERSION &&
      typeof payload.id === 'string' &&
      typeof payload.workdir === 'string'
    );
  }

  _markCorrupt(filePath) {
    try {
      fs.renameSync(filePath, filePath + '.corrupt');
    } catch {}
  }
}

function serialize(session) {
  const fileBaselines = {};
  for (const [k, v] of Object.entries(session.fileBaselines || {})) {
    if (typeof v !== 'string') continue;
    if (v.length > MAX_BASELINE_SIZE) continue;
    fileBaselines[k] = v;
  }
  return {
    version: VERSION,
    id: session.id,
    name: session.name,
    workdir: session.workdir,
    policyId: session.policyId,
    parentSessionId: session.parentSessionId || null,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    status: session.status,
    claudeSessionId: session.claudeSessionId,
    turns: session.turns,
    tools: session.tools,
    changes: session.changes,
    lastChangeMap: session.lastChangeMap,
    fileBaselines,
    pendingApprovals: [],
    events: session.events,
  };
}
