// memoryEngine — pure functions that turn raw session events into normalized
// memory entries (`habit` / `experience`) and look them up at decision time.
// No I/O, no state — receives `entries` arrays and the inputs it needs.
import { createHash } from 'node:crypto';
import path from 'node:path';

import { newMemoryId } from './memoryStore.js';

// ---------- Hashing & redaction ----------

export function hashWorkdir(workdir) {
  if (!workdir) return null;
  return createHash('sha1').update(workdir).digest('hex').slice(0, 12);
}

const SECRET_PATTERNS = [
  // KEY/TOKEN/SECRET/PASSWORD-shaped variable assignments.
  { re: /([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PWD|PASS)[A-Za-z0-9_]*\s*[=:]\s*)(\S+)/gi,
    repl: '$1<redacted>' },
  // Common API token shapes (anchored — must look like a real token).
  { re: /sk-[A-Za-z0-9_-]{20,}/g, repl: '<redacted>' },
  { re: /ghp_[A-Za-z0-9_-]{20,}/g, repl: '<redacted>' },
  { re: /AKIA[A-Z0-9]{12,}/g, repl: '<redacted>' },
  // Bearer auth.
  { re: /(Authorization\s*:\s*Bearer\s+)\S+/gi, repl: '$1<redacted>' },
  // CLI flag forms.
  { re: /(--password=|--token=|--api[-_]key=)\S+/gi, repl: '$1<redacted>' },
];

export function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.repl);
  return out;
}

const MAX_FIELD = 4096;
const MAX_TOTAL = 8192;

export function redactInput(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    const r = redactString(input);
    return r.length > MAX_FIELD ? r.slice(0, MAX_FIELD) + '…' : r;
  }
  if (Array.isArray(input)) return input.map(redactInput);
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = redactInput(v);
    const serialized = JSON.stringify(out);
    if (serialized.length > MAX_TOTAL) {
      return { _truncated: true, _size: serialized.length };
    }
    return out;
  }
  return input;
}

// ---------- keySignature ----------

export function keyFor(tool, input, workdir) {
  const safeInput = redactInput(input);
  const kind = tool === 'AskUserQuestion' ? 'auq' : 'tool';
  let keySignature;

  if (tool === 'Bash') {
    keySignature = bashKey(safeInput);
  } else if (tool === 'Read') {
    keySignature = readKey(safeInput, workdir);
  } else if (tool === 'Edit' || tool === 'Write') {
    keySignature = editWriteKey(tool, safeInput, workdir);
  } else if (tool === 'WebFetch') {
    keySignature = webfetchKey(safeInput);
  } else if (tool === 'WebSearch') {
    keySignature = 'websearch:*';
  } else if (tool === 'AskUserQuestion') {
    // For AUQ the key is set per-answer in the extractor; here just return the question hash.
    keySignature = `auq:${stableHash(safeInput).slice(0, 16)}`;
  } else if (tool === 'Glob' || tool === 'Grep') {
    keySignature = `${tool.toLowerCase()}:*`;
  } else {
    keySignature = `${tool.toLowerCase()}:${stableHash(safeInput).slice(0, 12)}`;
  }

  return { kind, keySignature, inputSample: safeInput };
}

function bashKey(input) {
  const cmd = (input?.command || input?.cmd || '').trim();
  if (!cmd) return 'bash:<empty>';
  // Strip everything after `--` (script-level args) for matching purposes.
  const cutAt = cmd.indexOf(' -- ');
  const head = cutAt >= 0 ? cmd.slice(0, cutAt) : cmd;
  const tokens = head.split(/\s+/).filter(Boolean);
  let arg0 = tokens[0] || '';
  // Inline env-var assignments (KEY=val) come before the actual command — skip them.
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i > 0) arg0 = tokens[i] || '';
  // Replace bare paths with placeholder.
  if (/^\.{0,2}\//.test(arg0)) arg0 = '<path>';
  arg0 = arg0.toLowerCase();
  // Pick second token if it's a subcommand (no leading dash, no path char).
  const arg1 = tokens[i + 1];
  if (arg1 && !arg1.startsWith('-') && !/[/$`]/.test(arg1)) {
    return `bash:${arg0}:${arg1.toLowerCase()}`;
  }
  return `bash:${arg0}`;
}

function readKey(input, workdir) {
  const p = input?.file_path || input?.path || '';
  if (!p) return 'read:<empty>';
  const base = path.basename(p);
  if (/(^|\.)env(\.|$)/.test(base) || /\.key$/.test(base) || /^id_rsa/.test(base)) {
    return 'read:env-like';
  }
  const ext = (path.extname(p) || '').toLowerCase().replace('.', '') || 'noext';
  return `read:${ext}`;
}

function editWriteKey(tool, input, workdir) {
  const p = input?.file_path || input?.path || input?.notebook_path || '';
  if (!p) return `${tool.toLowerCase()}:<empty>`;
  const ext = (path.extname(p) || '').toLowerCase().replace('.', '') || 'noext';
  let topDir = '';
  try {
    if (workdir) {
      const rel = path.relative(workdir, p);
      if (rel && !rel.startsWith('..')) topDir = rel.split(path.sep)[0];
    }
  } catch {}
  if (!topDir) topDir = '<root>';
  return `${tool.toLowerCase()}:${ext}:${topDir}`;
}

function webfetchKey(input) {
  const url = input?.url || '';
  try {
    const u = new URL(url);
    return `webfetch:${u.host}`;
  } catch {
    return 'webfetch:<invalid>';
  }
}

function stableHash(obj) {
  return createHash('sha1')
    .update(JSON.stringify(obj, Object.keys(obj || {}).sort()))
    .digest('hex');
}

// ---------- AUQ key for answer-tracking ----------

export function auqAnswerKey(question, pickedLabel) {
  const qhash = createHash('sha1').update(String(question || '')).digest('hex').slice(0, 16);
  const label = String(pickedLabel || '').toLowerCase().slice(0, 64);
  return `auq:${qhash}:${label}`;
}

// ---------- Lookup ----------

export function lookupHabit(entries, { keySignature, workdirHash }) {
  if (!keySignature) return null;
  // Prefer workdir-scoped match.
  for (const e of entries) {
    if (e.kind !== 'habit') continue;
    if (e.keySignature !== keySignature) continue;
    if (e.scope === 'workdir' && e.workdirHash === workdirHash) return e;
  }
  for (const e of entries) {
    if (e.kind !== 'habit') continue;
    if (e.keySignature !== keySignature) continue;
    if (e.scope === 'global') return e;
  }
  return null;
}

// ---------- Fast-path auto-decide ----------

const FAST_PATH_DOM_THRESHOLD = 5;
const NINETY_DAYS = 90 * 24 * 3600 * 1000;
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

export function shouldAutoApply(entry, now = Date.now()) {
  if (!entry || entry.kind !== 'habit') return null;
  if (entry.frozen) return null;
  const counts = entry.counts || { approve: 0, reject: 0 };
  const dom = Math.max(counts.approve, counts.reject);
  const sub = Math.min(counts.approve, counts.reject);
  if (dom < FAST_PATH_DOM_THRESHOLD || sub > 0) return null;
  if (!entry.lastTs || now - entry.lastTs > NINETY_DAYS) return null;
  if (entry.lastOpposingTs && now - entry.lastOpposingTs <= THIRTY_DAYS) return null;
  return counts.approve >= counts.reject ? 'approve' : 'reject';
}

// ---------- Merge / commit ----------

// Merge a candidate habit (from extractor) into the entries array.
// If a same-key+same-scope entry exists, increment counts and append session
// history. Otherwise create a new entry.
export function mergeHabit(entries, candidate, now = Date.now()) {
  const found = entries.find(
    (e) => e.kind === 'habit' &&
           e.keySignature === candidate.keySignature &&
           e.scope === candidate.scope &&
           (e.scope === 'global' || e.workdirHash === candidate.workdirHash),
  );
  if (!found) {
    const created = {
      id: newMemoryId('h'),
      kind: 'habit',
      scope: candidate.scope,
      workdirHash: candidate.workdirHash || null,
      tool: candidate.tool,
      keySignature: candidate.keySignature,
      inputSample: candidate.inputSample,
      counts: { approve: candidate.counts?.approve || 0, reject: candidate.counts?.reject || 0 },
      lastDecision: candidate.lastDecision || null,
      lastNote: candidate.lastNote || '',
      lastTs: candidate.lastTs || now,
      lastOpposingTs: null,
      sessions: candidate.sessions ? candidate.sessions.slice(-20) : [],
      frozen: false,
      redactionVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    entries.push(created);
    return { entry: created, action: 'created' };
  }
  // Existing — sum counts, append sessions, update timestamps.
  const prevDom = found.lastDecision;
  found.counts.approve += candidate.counts?.approve || 0;
  found.counts.reject += candidate.counts?.reject || 0;
  if (candidate.lastDecision) found.lastDecision = candidate.lastDecision;
  if (candidate.lastNote) found.lastNote = candidate.lastNote;
  found.lastTs = candidate.lastTs || now;
  if (prevDom && candidate.lastDecision && prevDom !== candidate.lastDecision) {
    found.lastOpposingTs = found.lastTs;
  }
  if (candidate.sessions && candidate.sessions.length) {
    found.sessions = [...(found.sessions || []), ...candidate.sessions].slice(-20);
  }
  found.updatedAt = now;
  return { entry: found, action: 'updated' };
}

export function mergeExperience(entries, candidate, now = Date.now()) {
  const created = {
    id: newMemoryId('e'),
    kind: 'experience',
    scope: candidate.scope || 'workdir',
    workdirHash: candidate.workdirHash || null,
    title: String(candidate.title || '').slice(0, 200),
    body: redactString(String(candidate.body || '').slice(0, 4000)),
    tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 10).map(String) : [],
    triggers: {
      tools: Array.isArray(candidate.triggers?.tools) ? candidate.triggers.tools.map(String).slice(0, 10) : [],
      pathGlobs: Array.isArray(candidate.triggers?.pathGlobs) ? candidate.triggers.pathGlobs.map(String).slice(0, 10) : [],
      keywords: Array.isArray(candidate.triggers?.keywords) ? candidate.triggers.keywords.map(String).slice(0, 20) : [],
    },
    weight: typeof candidate.weight === 'number' ? candidate.weight : 1,
    sourceSession: candidate.sourceSession || null,
    sourceTurn: candidate.sourceTurn || null,
    confirmed: candidate.confirmed !== false,
    enabledForInjection: candidate.enabledForInjection !== false,
    enabledForDecider: candidate.enabledForDecider !== false,
    createdAt: now,
    updatedAt: now,
  };
  entries.push(created);
  return { entry: created, action: 'created' };
}

// ---------- Filtering helpers (used by retriever) ----------

export function relevantHabits(entries, { workdirHash, tool }) {
  return entries.filter(
    (e) => e.kind === 'habit' &&
      (e.scope === 'global' || e.workdirHash === workdirHash) &&
      (!tool || e.tool === tool),
  );
}

export function allExperiences(entries, { workdirHash } = {}) {
  return entries.filter(
    (e) => e.kind === 'experience' && e.confirmed &&
      (!workdirHash || e.scope === 'global' || e.workdirHash === workdirHash),
  );
}
