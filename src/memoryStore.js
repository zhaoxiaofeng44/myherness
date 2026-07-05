// MemoryStore — owns persistence of the global memory file.
// Mirrors SessionStore's pattern: debounced atomic writes, version-validated,
// corrupt files renamed rather than crashing the server.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const DEBOUNCE_MS = 200;

export class MemoryStore {
  constructor({ file }) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.entries = []; // in-memory canonical state
    this._timer = null;
    this._loaded = false;
  }

  load() {
    if (this._loaded) return this.entries;
    this._loaded = true;
    if (!fs.existsSync(this.file)) {
      this.entries = [];
      return this.entries;
    }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const payload = JSON.parse(raw);
      if (this._validate(payload)) {
        this.entries = Array.isArray(payload.entries) ? payload.entries : [];
      } else {
        this._markCorrupt();
        this.entries = [];
      }
    } catch {
      this._markCorrupt();
      this.entries = [];
    }
    return this.entries;
  }

  scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._writeNow();
    }, DEBOUNCE_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._writeNow();
  }

  _writeNow() {
    const payload = { version: VERSION, entries: this.entries };
    const jsonStr = JSON.stringify(payload, null, 2);
    const tmp = this.file + '.tmp';
    fs.writeFile(tmp, jsonStr, (err) => {
      if (err) {
        console.error('[memoryStore] write failed:', err.message);
        try { fs.unlinkSync(tmp); } catch {}
        return;
      }
      fs.rename(tmp, this.file, (renameErr) => {
        if (renameErr) {
          console.error('[memoryStore] rename failed:', renameErr.message);
          try { fs.unlinkSync(tmp); } catch {}
        }
      });
    });
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // shutdown 时同步写盘确保数据完整
    const payload = { version: VERSION, entries: this.entries };
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[memoryStore] flush failed:', e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  _validate(payload) {
    return payload && payload.version === VERSION && Array.isArray(payload.entries);
  }

  _markCorrupt() {
    try {
      fs.renameSync(this.file, this.file + '.corrupt.' + Date.now());
    } catch {}
  }

  // Mutators are thin — engine functions do the work, store records the
  // change and triggers a save.
  upsert(entry) {
    const i = this.entries.findIndex((e) => e.id === entry.id);
    if (i === -1) this.entries.push(entry);
    else this.entries[i] = entry;
    this.scheduleSave();
    return entry;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) this.scheduleSave();
    return before !== this.entries.length;
  }

  replaceAll(entries) {
    this.entries = entries;
    this.scheduleSave();
  }
}

export function newMemoryId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}
