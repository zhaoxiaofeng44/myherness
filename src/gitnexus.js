// GitNexus integration — wraps the `gitnexus` CLI and its MCP stdio server.
// We intentionally do NOT take gitnexus as an npm dependency: the CLI is
// invoked through `npx -y gitnexus@latest <args>`, so the console works on
// any machine without bloating package.json. MCP requests use the standard
// LSP-style `Content-Length` framing.
import { spawn } from 'node:child_process';

const CLI_PKG = 'gitnexus@latest';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

let _availability = null;

export async function isAvailable({ force = false } = {}) {
  if (_availability && !force) return _availability;
  try {
    const { stdout, code } = await runCli(['--version'], { timeoutMs: 30_000 });
    if (code === 0) {
      _availability = { available: true, version: stdout.trim() };
    } else {
      _availability = { available: false, error: 'gitnexus --version 退出码 ' + code };
    }
  } catch (e) {
    _availability = { available: false, error: e.message };
  }
  return _availability;
}

// `gitnexus status` in current repo. Returns { indexed, raw, summary }.
export async function getStatus(workdir) {
  const { stdout, stderr, code } = await runCli(['status'], { cwd: workdir, timeoutMs: 30_000 });
  const raw = (stdout + (stderr ? '\n' + stderr : '')).trim();
  if (code !== 0) {
    return { indexed: false, raw, summary: { error: raw || `exit ${code}` } };
  }
  return { indexed: detectIndexed(raw), raw, summary: parseStatus(raw) };
}

// Stream `gitnexus analyze` with optional flags. onLine is called for each
// stdout/stderr line. Resolves with { code }.
export function analyze(workdir, opts = {}) {
  // Note: gitnexus 1.6+ has embeddings OFF by default — pass `--embeddings` to
  // opt in. We default to OFF (cheap, no API key needed). `--skip-agents-md`
  // is on by default to avoid mutating the user's repo.
  const args = ['analyze'];
  if (opts.force) args.push('--force');
  if (opts.embeddings) args.push('--embeddings');
  if (opts.skipAgentsMd !== false) args.push('--skip-agents-md');
  return new Promise((resolve, reject) => {
    const child = spawnNpx(args, workdir);
    let timer;
    const onLine = opts.onLine || (() => {});
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
      }, opts.idleTimeoutMs || 600_000);
    };
    reset();
    pipeLines(child.stdout, (line) => { onLine({ stream: 'stdout', line }); reset(); });
    pipeLines(child.stderr, (line) => { onLine({ stream: 'stderr', line }); reset(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1 });
    });
  });
}

// Call a single MCP tool, then close the server. For read-mostly UI use, this
// 1-shot policy keeps the implementation simple at the cost of a ~1-2s cold
// start per call. Returns the raw JSON-RPC `result` payload.
export function callTool(workdir, name, args = {}, opts = {}) {
  return mcpRpc(workdir, opts.timeoutMs || 30_000, async (rpc) => {
    return await rpc('tools/call', { name, arguments: args });
  });
}

// Read a Resource. `uri` like `gitnexus://repo/<name>/processes`.
export function readResource(workdir, uri, opts = {}) {
  return mcpRpc(workdir, opts.timeoutMs || 30_000, async (rpc) => {
    return await rpc('resources/read', { uri });
  });
}

// List indexed repos via the `list_repos` tool.
export async function listRepos(workdir, opts = {}) {
  const result = await callTool(workdir, 'list_repos', {}, opts);
  return parseToolText(result);
}

// Run a Cypher query against the repo's knowledge graph (Kuzu / LadybugDB).
// The MCP `cypher` tool returns either { markdown, row_count } or { error };
// we parse the markdown into row objects so callers get structured data.
export async function cypher(workdir, query, params = {}, opts = {}) {
  const result = await callTool(workdir, 'cypher', { query, params }, opts);
  const payload = parseToolText(result);
  if (payload && typeof payload === 'object') {
    if (payload.error) throw new Error('cypher: ' + payload.error);
    if (typeof payload.markdown === 'string') return parseMarkdownTable(payload.markdown);
  }
  return payload;
}

// Convenience: function/method call graph. GitNexus models all relationships
// via a single `CodeRelation` REL with `r.type` discriminator (CALLS, DEFINES,
// MEMBER_OF, …). We only follow `r.type = 'CALLS'` between callable nodes.
export async function getCallGraph(workdir, { limit = 300 } = {}) {
  const cap = Math.max(1, Math.min(2000, limit | 0));
  const q = `MATCH (a)-[r:CodeRelation]->(b)
WHERE r.type = 'CALLS'
RETURN a.name AS fromName, a.filePath AS fromFile,
       b.name AS toName, b.filePath AS toFile
LIMIT ${cap}`;
  const rows = await cypher(workdir, q);
  return shapeCallGraph(rows);
}

// Convenience: processes (execution flows) with step counts. Process nodes use
// `label` (not `name`) and carry an authoritative `stepCount` already.
export async function getProcesses(workdir, { limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(500, limit | 0));
  const q = `MATCH (p:Process)
RETURN p.label AS name, p.id AS id, p.stepCount AS steps, p.processType AS kind
ORDER BY steps DESC
LIMIT ${cap}`;
  return await cypher(workdir, q);
}

// Convenience: blast radius for a symbol name. Falls back to `query` when
// `impact` rejects ambiguous targets.
export async function getImpact(workdir, symbol) {
  try {
    return await callTool(workdir, 'impact', { target: symbol });
  } catch (e) {
    return await callTool(workdir, 'context', { symbol });
  }
}

// ===== internals =====

function spawnNpx(args, cwd, { withStdin = false } = {}) {
  return spawn(NPX, ['-y', CLI_PKG, ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NPX, ['-y', CLI_PKG, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, opts.timeoutMs || 60_000);
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

function pipeLines(stream, cb) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.length) cb(line);
    }
  });
  stream.on('end', () => {
    if (buf.length) cb(buf);
  });
}

// Stand up an MCP stdio session, run an async sender, then close.
async function mcpRpc(workdir, timeoutMs, fn) {
  const child = spawnNpx(['mcp'], workdir, { withStdin: true });
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject }
  let buf = Buffer.alloc(0);
  let closed = false;
  let stderrBuf = '';

  const killTimer = setTimeout(() => {
    closed = true;
    try { child.kill('SIGTERM'); } catch {}
    for (const { reject } of pending.values()) reject(new Error('MCP 调用超时'));
    pending.clear();
  }, timeoutMs);

  child.stderr.on('data', (b) => { stderrBuf += b.toString(); if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-8_000); });

  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // Drop malformed header
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const total = headerEnd + 4 + len;
      if (buf.length < total) break;
      const body = buf.slice(headerEnd + 4, total).toString('utf8');
      buf = buf.slice(total);
      try {
        const msg = JSON.parse(body);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else resolve(msg.result);
        }
      } catch {}
    }
  });

  child.on('error', () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('MCP 进程异常'));
    pending.clear();
  });
  child.on('close', () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('MCP 提前关闭：' + stderrBuf.trim().slice(-400)));
    pending.clear();
  });

  function send(obj) {
    const body = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    child.stdin.write(header + body);
  }

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('MCP 已关闭'));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-code-console', version: '0.1.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return await fn(rpc);
  } finally {
    clearTimeout(killTimer);
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }
}

// Pull JSON / text out of an MCP tool result. Tools return content[] of
// `{type:'text', text}` blocks; many wrap a JSON payload as text.
function parseToolText(result) {
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter((c) => c && c.type === 'text').map((c) => c.text);
  const joined = texts.join('\n');
  if (!joined.trim()) return result;
  // GitNexus appends a `\n---\n**Next:** …` hint after every tool payload.
  // Strip it before attempting JSON.parse.
  const sep = joined.indexOf('\n---\n');
  const head = sep === -1 ? joined : joined.slice(0, sep);
  try { return JSON.parse(head); } catch { return head; }
}

function shapeCallGraph(data) {
  const rows = Array.isArray(data) ? data : [];
  const nodeMap = new Map();
  const edges = [];
  const ensure = (name, file, kind) => {
    const id = `${file || ''}::${name || '?'}`;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, name: name || id, file: file || '', kind: kind || '', inDeg: 0, outDeg: 0 });
    }
    return nodeMap.get(id);
  };
  for (const r of rows) {
    if (!r.fromName || !r.toName) continue;
    const a = ensure(r.fromName, r.fromFile, r.fromKind);
    const b = ensure(r.toName, r.toFile, r.toKind);
    a.outDeg++; b.inDeg++;
    edges.push({ from: a.id, to: b.id });
  }
  return { nodes: Array.from(nodeMap.values()), edges, raw: rows.length };
}

// Parse the GitHub-flavored markdown table that GitNexus's `cypher` tool
// returns. Format:  `| col1 | col2 |\n| --- | --- |\n| v1 | v2 |\n…`
// Cells may contain JSON-encoded scalars (e.g. `"foo"`, `[1,2]`); we try
// JSON.parse first and fall back to the raw string.
function parseMarkdownTable(md) {
  const lines = md.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitMdRow(lines[0]);
  // lines[1] is the divider `| --- | --- |`
  const out = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitMdRow(lines[i]);
    if (cells.length === 0) continue;
    const row = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = decodeMdCell(cells[c] ?? '');
    }
    out.push(row);
  }
  return out;
}

function splitMdRow(line) {
  // Strip leading/trailing pipes, split, trim cells.
  const trimmed = line.replace(/^\||\|$/g, '');
  return trimmed.split('|').map((c) => c.trim());
}

function decodeMdCell(cell) {
  if (cell === '' || cell === 'null') return null;
  // GitNexus escapes inner quotes (\"); try JSON parse first.
  try { return JSON.parse(cell); } catch {}
  return cell;
}

function detectIndexed(raw) {
  if (!raw) return false;
  if (/not\s+indexed|no\s+index|repository\s+not\s+indexed/i.test(raw)) return false;
  return /^Indexed[:\s]/im.test(raw)
    || /up[-\s]?to[-\s]?date|stale|out[-\s]?of[-\s]?date/i.test(raw);
}

function parseStatus(raw) {
  const out = {};
  const grab = (re, key) => {
    const m = raw.match(re);
    if (m) out[key] = m[1].trim();
  };
  const num = (re, key) => {
    const m = raw.match(re);
    if (m) out[key] = parseInt(m[1].replace(/[,_]/g, ''), 10);
  };
  // Format used by gitnexus 1.6.x:
  //   Repository: /path
  //   Indexed: 5/15/2026, 4:02:07 PM
  //   Indexed commit: <sha>
  //   Current commit: <sha>
  //   Status: ✅ up-to-date | ⚠ stale | ...
  grab(/^Repository[:\s]+(.+)$/im, 'repo');
  grab(/^Indexed[:\s]+(.+)$/im, 'lastIndexed');
  grab(/^Indexed commit[:\s]+([0-9a-f]+)/im, 'indexedCommit');
  grab(/^Current commit[:\s]+([0-9a-f]+)/im, 'currentCommit');
  grab(/^Status[:\s]+(.+)$/im, 'statusLine');
  // Best-effort numeric fields if a future version adds them:
  num(/files?\s*[:=]\s*([\d,_]+)/i, 'files');
  num(/symbols?\s*[:=]\s*([\d,_]+)/i, 'symbols');
  num(/nodes?\s*[:=]\s*([\d,_]+)/i, 'nodes');
  num(/edges?\s*[:=]\s*([\d,_]+)/i, 'edges');
  if (out.statusLine && /stale|out[-\s]?of[-\s]?date/i.test(out.statusLine)) out.stale = true;
  if (out.indexedCommit && out.currentCommit && out.indexedCommit !== out.currentCommit) out.stale = true;
  return out;
}
