// Claude Code Console — single-process Node server.
// Serves a static UI (public/), exposes a small JSON API, and broadcasts
// session events over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionManager } from './src/sessionManager.js';
import { SessionStore } from './src/sessionStore.js';
import { MemoryStore } from './src/memoryStore.js';
import { DeciderQueue } from './src/deciderQueue.js';
import { PRESET_POLICIES, getPolicy } from './src/policyEngine.js';
import { scanStructure, annotateChanges } from './src/structure.js';
import { buildDesignGraph } from './src/designGraph.js';
import { buildCodeMap } from './src/codeMap.js';
import * as gitnexus from './src/gitnexus.js';
import { extractHabits } from './src/habitExtractor.js';
import { distillExperiences } from './src/memoryDistiller.js';
import { mergeHabit, mergeExperience, hashWorkdir } from './src/memoryEngine.js';
import { relevantForPrompt } from './src/memoryRetriever.js';
import { TerminalManager } from './src/terminalManager.js';
import { GOAL_PROMPT_PATHS } from './src/goalRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '4477', 10);

const DATA_DIR =
  process.env.CLAUDE_CONSOLE_DATA || path.join(__dirname, '.claude-console', 'sessions');
const MEMORY_FILE = path.join(path.dirname(DATA_DIR), 'memory.json');
const store = new SessionStore({ dir: DATA_DIR });
const memoryStore = new MemoryStore({ file: MEMORY_FILE });
memoryStore.load();
const deciderQueue = new DeciderQueue();
const manager = new SessionManager({ store, memoryStore, deciderQueue });
for (const persisted of store.loadAll()) {
  try {
    manager.hydrate(persisted);
  } catch (e) {
    console.error(`[startup] failed to hydrate ${persisted?.id}:`, e.message);
  }
}
const sseClients = new Set();

const terminals = new TerminalManager({ broadcast });

manager.on('session:event', (payload) => broadcast('event', payload));
manager.on('session:updated', (payload) => broadcast('session:updated', payload));
manager.on('session:created', (payload) => broadcast('session:created', payload));
manager.on('session:removed', (payload) => {
  broadcast('session:removed', payload);
  terminals.kill(payload.id);
});

function broadcast(kind, data) {
  const line = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const parsed = { query: Object.fromEntries(reqUrl.searchParams) };

  // CORS friendliness for local tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true });
    if (pathname === '/api/gitnexus/health' && req.method === 'GET') {
      const force = reqUrl.searchParams.get('force') === '1';
      const info = await gitnexus.isAvailable({ force });
      return json(res, 200, info);
    }
    if (pathname === '/api/policies') return json(res, 200, { policies: PRESET_POLICIES });

    if (pathname === '/api/goal/info' && req.method === 'GET') {
      const wd = parsed.query.workdir || '';
      const projectPath = wd ? path.join(wd, GOAL_PROMPT_PATHS.projectRel) : null;
      const readSafe = (p) => {
        try {
          if (p && fs.existsSync(p) && fs.statSync(p).isFile())
            return fs.readFileSync(p, 'utf8');
        } catch {}
        return '';
      };
      return json(res, 200, {
        globalPath: GOAL_PROMPT_PATHS.global,
        projectPath,
        globalContent: readSafe(GOAL_PROMPT_PATHS.global),
        projectContent: readSafe(projectPath),
      });
    }

    if (pathname === '/api/sessions' && req.method === 'GET')
      return json(res, 200, { sessions: manager.list() });
    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      const s = manager.create(body);
      return json(res, 201, { session: s.summary() });
    }
    if (pathname === '/api/cwd' && req.method === 'GET')
      return json(res, 200, { cwd: process.cwd() });

    // ===== Memory routes =====
    if (pathname === '/api/memory' && req.method === 'GET') {
      const wd = parsed.query.workdir;
      const kind = parsed.query.kind;
      let entries = memoryStore.entries.slice();
      if (kind) entries = entries.filter((e) => e.kind === kind);
      if (wd) {
        const wdHash = hashWorkdir(wd);
        entries = entries.filter((e) => e.scope === 'global' || e.workdirHash === wdHash);
      }
      return json(res, 200, { entries });
    }

    if (pathname === '/api/memory/commit' && req.method === 'POST') {
      const body = await readJson(req);
      const habits = Array.isArray(body.habits) ? body.habits : [];
      const experiences = Array.isArray(body.experiences) ? body.experiences : [];
      const created = [];
      const updated = [];
      for (const h of habits) {
        const result = mergeHabit(memoryStore.entries, h);
        if (result.action === 'created') created.push(result.entry);
        else updated.push(result.entry);
      }
      for (const e of experiences) {
        const result = mergeExperience(memoryStore.entries, e);
        created.push(result.entry);
      }
      memoryStore.scheduleSave();
      broadcast('memory:updated', { commitCount: habits.length + experiences.length });
      return json(res, 200, { ok: true, created: created.length, updated: updated.length });
    }

    if (pathname === '/api/memory/relevant' && req.method === 'GET') {
      const wd = parsed.query.workdir || '';
      const promptText = parsed.query.prompt || '';
      const session = parsed.query.sessionId ? manager.get(parsed.query.sessionId) : null;
      const modifiedPaths = session
        ? (session.changes || []).flatMap((c) => (c.files || []).map((f) => f.relPath)).filter(Boolean)
        : [];
      const items = relevantForPrompt(memoryStore.entries, {
        workdir: wd, prompt: promptText, modifiedPaths,
      });
      return json(res, 200, { items });
    }

    const memSingleMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (memSingleMatch) {
      const id = memSingleMatch[1];
      const entry = memoryStore.entries.find((e) => e.id === id);
      if (!entry && req.method !== 'POST') return json(res, 404, { error: '记忆不存在' });
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (body.title !== undefined) entry.title = String(body.title).slice(0, 200);
        if (body.body !== undefined) entry.body = String(body.body).slice(0, 4000);
        if (Array.isArray(body.tags)) entry.tags = body.tags.map(String).slice(0, 10);
        if (body.triggers && typeof body.triggers === 'object') {
          entry.triggers = {
            tools: Array.isArray(body.triggers.tools) ? body.triggers.tools.map(String).slice(0, 10) : (entry.triggers?.tools || []),
            pathGlobs: Array.isArray(body.triggers.pathGlobs) ? body.triggers.pathGlobs.map(String).slice(0, 10) : (entry.triggers?.pathGlobs || []),
            keywords: Array.isArray(body.triggers.keywords) ? body.triggers.keywords.map(String).slice(0, 20) : (entry.triggers?.keywords || []),
          };
        }
        if (typeof body.weight === 'number') entry.weight = body.weight;
        if (body.counts && typeof body.counts === 'object') {
          entry.counts = {
            approve: Number(body.counts.approve) || 0,
            reject: Number(body.counts.reject) || 0,
          };
        }
        if (typeof body.frozen === 'boolean') entry.frozen = body.frozen;
        if (typeof body.enabledForInjection === 'boolean') entry.enabledForInjection = body.enabledForInjection;
        if (typeof body.enabledForDecider === 'boolean') entry.enabledForDecider = body.enabledForDecider;
        entry.updatedAt = Date.now();
        memoryStore.scheduleSave();
        broadcast('memory:updated', { entry });
        return json(res, 200, { entry });
      }
      if (req.method === 'DELETE') {
        memoryStore.remove(id);
        broadcast('memory:updated', { removedId: id });
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(`event: ping\ndata: {}\n\n`);
        } catch {}
      }, 25_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    // /api/sessions/:id...
    const match = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (match) {
      const id = match[1];
      const rest = match[2] || '';
      const session = manager.get(id);
      if (!session) return json(res, 404, { error: '会话不存在' });

      if (rest === '' || rest === '/') {
        if (req.method === 'GET') {
          return json(res, 200, {
            session: session.summary(),
            policy: getPolicy(session.policyId),
            turns: session.turns,
            events: session.events,
            tools: session.tools,
            changes: session.changes,
            pendingApprovals: Array.from(session.pendingApprovals.values()),
          });
        }
        if (req.method === 'DELETE') {
          manager.remove(id);
          return json(res, 200, { ok: true });
        }
      }

      if (rest === '/prompt' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.prompt || typeof body.prompt !== 'string')
          return json(res, 400, { error: 'prompt 必填' });
        try {
          const turn = await session.sendPrompt(body.prompt);
          return json(res, 202, { turn });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (rest === '/cancel' && req.method === 'POST') {
        session.cancel();
        return json(res, 200, { ok: true });
      }

      if (rest === '/policy' && req.method === 'POST') {
        const body = await readJson(req);
        session.setPolicy(body.policyId);
        return json(res, 200, { ok: true });
      }

      if (rest === '/structure' && req.method === 'GET') {
        const tree = scanStructure(session.workdir);
        annotateChanges(tree, session.lastChangeMap);
        return json(res, 200, { tree });
      }

      if (rest === '/code-map' && req.method === 'GET') {
        try {
          const map = buildCodeMap(session.workdir);
          // Annotate symbols with last-change info using session.lastChangeMap
          const changeMap = session.lastChangeMap || {};
          for (const s of map.symbols) {
            const c = changeMap[s.relPath];
            if (c) s.lastChange = c;
          }
          for (const f of map.files) {
            const c = changeMap[f.relPath];
            if (c) f.lastChange = c;
          }
          return json(res, 200, { map });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      if (rest === '/design-graph' && req.method === 'GET') {
        const type = parsed.query.type || 'modules';
        try {
          const graph = await buildDesignGraph(session.workdir, { type });
          // Annotate changed nodes
          const changeMap = session.lastChangeMap || {};
          for (const n of graph.nodes) {
            const c = changeMap[n.relPath];
            if (c) n.lastChange = c;
          }
          return json(res, 200, { graph });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      if (rest === '/changes' && req.method === 'GET') {
        return json(res, 200, { changes: session.changes });
      }

      const approveMatch = rest.match(/^\/approve\/([^/]+)$/);
      if (approveMatch && req.method === 'POST') {
        const body = await readJson(req);
        const ok = session.resolveApproval(approveMatch[1], body.decision, body.note, {
          auqAnswers: Array.isArray(body.auqAnswers) ? body.auqAnswers : null,
        });
        return json(res, ok ? 200 : 404, { ok });
      }

      const cancelDeciderMatch = rest.match(/^\/approvals\/([^/]+)\/cancel-decider$/);
      if (cancelDeciderMatch && req.method === 'POST') {
        const ok = session.cancelDecider(cancelDeciderMatch[1]);
        return json(res, ok ? 200 : 404, { ok });
      }

      const distillMatch = rest.match(/^\/turns\/([^/]+)\/distill$/);
      if (distillMatch && req.method === 'POST') {
        const turnId = distillMatch[1];
        const body = await readJson(req).catch(() => ({}));
        const scope = body.scope === 'global' ? 'global' : 'workdir';
        const habits = extractHabits({ session, turnId, scope });
        let experiences = [];
        let distillError = null;
        if (body.includeExperiences !== false) {
          const guidance = typeof body.guidance === 'string' ? body.guidance.slice(0, 1000) : '';
          const result = await distillExperiences({ session, turnId, guidance });
          if (result.error) distillError = result.error;
          else experiences = result.items.map((it) => ({
            ...it,
            scope,
            workdirHash: scope === 'workdir' ? hashWorkdir(session.workdir) : null,
            sourceSession: session.id,
            sourceTurn: turnId,
          }));
        }
        return json(res, 200, { habits, experiences, distillError });
      }

      if (rest === '/term/attach' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const cols = body.cols | 0 || 80;
        const rows = body.rows | 0 || 24;
        terminals.ensure(session, { cols, rows });
        terminals.resize(session.id, cols, rows);
        return json(res, 200, { ok: true, replay: terminals.replay(session.id) });
      }

      if (rest === '/term/input' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const data = typeof body.data === 'string' ? body.data : '';
        if (!data) return json(res, 400, { error: 'data 必填' });
        terminals.ensure(session);
        const ok = terminals.write(session.id, data);
        return json(res, ok ? 200 : 500, { ok });
      }

      if (rest === '/term/resize' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const ok = terminals.resize(session.id, body.cols | 0, body.rows | 0);
        return json(res, ok ? 200 : 404, { ok });
      }

      if (rest === '/term/kill' && req.method === 'POST') {
        const ok = terminals.kill(session.id);
        return json(res, 200, { ok });
      }

      if (rest === '/gitnexus/status' && req.method === 'GET') {
        try {
          const info = await gitnexus.getStatus(session.workdir);
          return json(res, 200, info);
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      if (rest === '/gitnexus/analyze' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        // Fire-and-forget: stream lines via SSE, finish event when done.
        broadcast('gitnexus:start', { sessionId: id });
        gitnexus
          .analyze(session.workdir, {
            force: !!body.force,
            embeddings: !!body.embeddings,
            skipAgentsMd: body.skipAgentsMd !== false,
            onLine: ({ stream, line }) =>
              broadcast('gitnexus:progress', { sessionId: id, stream, line }),
          })
          .then((r) => broadcast('gitnexus:done', { sessionId: id, code: r.code }))
          .catch((e) => broadcast('gitnexus:done', { sessionId: id, error: e.message }));
        return json(res, 202, { ok: true });
      }

      if (rest === '/gitnexus/tool' && req.method === 'POST') {
        const body = await readJson(req);
        const kind = body.kind || 'tool';
        try {
          let payload;
          if (kind === 'callgraph') payload = await gitnexus.getCallGraph(session.workdir, body.args || {});
          else if (kind === 'processes') payload = await gitnexus.getProcesses(session.workdir, body.args || {});
          else if (kind === 'cypher')
            payload = await gitnexus.cypher(session.workdir, body.query, body.params || {});
          else if (kind === 'impact')
            payload = await gitnexus.getImpact(session.workdir, body.symbol);
          else if (kind === 'tool')
            payload = await gitnexus.callTool(session.workdir, body.name, body.args || {});
          else return json(res, 400, { error: '未知 kind: ' + kind });
          return json(res, 200, { result: payload });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      return json(res, 404, { error: '未知接口' });
    }

    // Static file serving from public/
    let urlPath = pathname === '/' ? '/index.html' : pathname;
    if (urlPath.includes('..')) return json(res, 400, { error: 'invalid path' });
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message });
  }
});

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}


function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('Invalid JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Claude Code Console running at http://localhost:${PORT}`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Session data dir: ${DATA_DIR}`);
  console.log(`Memory file: ${MEMORY_FILE}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { deciderQueue.abortAll(); } catch {}
  for (const s of manager.sessions.values()) {
    try { s.cancel(); } catch {}
  }
  // Defer one tick so any in-flight stdout `data` callbacks finish first.
  setImmediate(() => {
    try { store.flushAll(manager); } catch {}
    try { memoryStore.flush(); } catch {}
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('beforeExit', () => {
  try { store.flushAll(manager); } catch {}
  try { memoryStore.flush(); } catch {}
});
