// SessionStore — owns all on-disk persistence of Session state.
// Single-writer assumption: only one process should manage a given data dir.
// Running two `node server.js` against the same dir will clobber writes.
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2; // bumped: changes format changed (no diff lines persisted)
const DEBOUNCE_MS = 300;
// 持久化时只保留最近的 300 条事件，避免大型会话写盘卡死
const MAX_PERSISTED_EVENTS = 300;
// 持久化时只保留最近 50 条工具记录
const MAX_PERSISTED_TOOLS = 50;

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
    this._writeSessionSync(session);
  }

  flushAll(manager) {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    for (const session of manager.sessions.values()) {
      try {
        this._writeSessionSync(session);
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

  // 异步写盘：JSON.stringify 在主线程（无法避免），但 IO 操作异步化
  _writeSession(session) {
    const payload = serialize(session);
    const jsonStr = JSON.stringify(payload);
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = file + '.tmp';
    fs.writeFile(tmp, jsonStr, (err) => {
      if (err) {
        console.error(`[sessionStore] write failed ${session.id}:`, err.message);
        try { fs.unlinkSync(tmp); } catch {}
        return;
      }
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) {
          console.error(`[sessionStore] rename failed ${session.id}:`, renameErr.message);
          try { fs.unlinkSync(tmp); } catch {}
        }
      });
    });
  }

  // 同步写盘：用于 shutdown flush，确保数据完整写入
  _writeSessionSync(session) {
    const payload = serialize(session);
    const jsonStr = JSON.stringify(payload);
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, jsonStr);
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[sessionStore] flush write failed ${session.id}:`, e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  _validate(payload) {
    return (
      payload &&
      (payload.version === VERSION || payload.version === 1) &&
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
  // 不持久化 fileBaselines（纯内存缓存，启动后从文件重建）
  // 不持久化 changes 中的 diff lines（只保留摘要）

  const allEvents = Array.isArray(session.events) ? session.events : [];
  const events = allEvents.length > MAX_PERSISTED_EVENTS
    ? allEvents.slice(allEvents.length - MAX_PERSISTED_EVENTS)
    : allEvents;

  const allTools = Array.isArray(session.tools) ? session.tools : [];
  const tools = allTools.length > MAX_PERSISTED_TOOLS
    ? allTools.slice(allTools.length - MAX_PERSISTED_TOOLS)
    : allTools;

  const changes = (Array.isArray(session.changes) ? session.changes : []).map((cs) => ({
    turnId: cs.turnId,
    timestamp: cs.timestamp,
    // 只保留文件摘要，不存 diff lines（前端可按需从 API 拉取）
    files: (Array.isArray(cs.files) ? cs.files : []).map((f) => ({
      relPath: f.relPath,
      kind: f.kind,
      size: f.size,
      diffTruncated: f.diffTruncated || undefined,
    })),
  }));

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
    tools,
    changes,
    lastChangeMap: session.lastChangeMap,
    fileBaselines: {}, // 不持久化，启动后重建
    pendingApprovals: [],
    events,
  };
}