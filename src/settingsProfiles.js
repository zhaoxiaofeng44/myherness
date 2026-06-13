import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export class SettingsProfileStore {
  constructor({ file }) {
    this.file = file;
    this.profiles = [];
    this._saveTimer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      }
    } catch (e) {
      console.error('[SettingsProfileStore] load error:', e.message);
      this.profiles = [];
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ profiles: this.profiles }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[SettingsProfileStore] save error:', e.message);
    }
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 300);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._save();
  }

  list() {
    return this.profiles;
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  create({ name, content }) {
    const profile = {
      id: randomUUID().slice(0, 8),
      name: String(name || 'Untitled').slice(0, 100),
      content: content || {},
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.profiles.push(profile);
    this.scheduleSave();
    return profile;
  }

  update(id, { name, content }) {
    const p = this.get(id);
    if (!p) return null;
    if (name !== undefined) p.name = String(name).slice(0, 100);
    if (content !== undefined) p.content = content;
    p.updatedAt = Date.now();
    this.scheduleSave();
    return p;
  }

  remove(id) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.profiles.splice(idx, 1);
    this.scheduleSave();
    return true;
  }

  activate(id) {
    const target = this.get(id);
    if (!target) return null;
    const prevActive = this.profiles.find((p) => p.isActive);
    for (const p of this.profiles) p.isActive = false;
    target.isActive = true;
    target.updatedAt = Date.now();

    try {
      const dir = path.dirname(CLAUDE_SETTINGS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(target.content, null, 2));
    } catch (e) {
      target.isActive = false;
      if (prevActive) prevActive.isActive = true;
      throw new Error('写入 settings.json 失败: ' + e.message);
    }
    this.scheduleSave();
    return target;
  }

  readCurrentSettings() {
    try {
      if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
        return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      }
    } catch {}
    return null;
  }
}
