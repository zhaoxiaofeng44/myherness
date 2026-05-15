// Claude Code Console — single-process Node server.
// Serves a static UI (public/), exposes a small JSON API, and broadcasts
// session events over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionManager } from './src/sessionManager.js';
import { PRESET_POLICIES, getPolicy } from './src/policyEngine.js';
import { scanStructure, annotateChanges } from './src/structure.js';
import { buildDesignGraph } from './src/designGraph.js';
import { buildCodeMap } from './src/codeMap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '4477', 10);

const manager = new SessionManager();
const sseClients = new Set();

manager.on('session:event', (payload) => broadcast('event', payload));
manager.on('session:updated', (payload) => broadcast('session:updated', payload));
manager.on('session:created', (payload) => broadcast('session:created', payload));
manager.on('session:removed', (payload) => broadcast('session:removed', payload));

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
    if (pathname === '/api/policies') return json(res, 200, { policies: PRESET_POLICIES });
    if (pathname === '/api/sessions' && req.method === 'GET')
      return json(res, 200, { sessions: manager.list() });
    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      const s = manager.create(body);
      return json(res, 201, { session: s.summary() });
    }
    if (pathname === '/api/cwd' && req.method === 'GET')
      return json(res, 200, { cwd: process.cwd() });

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
        const ok = session.resolveApproval(approveMatch[1], body.decision, body.note);
        return json(res, ok ? 200 : 404, { ok });
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
});
