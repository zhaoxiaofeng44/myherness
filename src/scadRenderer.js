// Spawn the local `openscad` CLI to convert .scad source to a binary STL.
// Matches the project's existing CLI-spawn pattern (claude, madge, gitnexus).
// If openscad is missing, returns a structured error the UI can display
// with install instructions, instead of crashing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let _cachedBin = undefined; // undefined = unprobed, null = not found, string = path

function locateBinary() {
  if (_cachedBin !== undefined) return _cachedBin;
  const candidates = [
    'openscad',
    '/opt/homebrew/bin/openscad',
    '/usr/local/bin/openscad',
    '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD',
  ];
  for (const c of candidates) {
    try {
      // For PATH-based name, defer to spawn; for absolute paths, check existence.
      if (c.startsWith('/') && !fs.existsSync(c)) continue;
      _cachedBin = c;
      return _cachedBin;
    } catch {}
  }
  _cachedBin = null;
  return null;
}

export function isAvailable() {
  return new Promise((resolve) => {
    const bin = locateBinary();
    if (!bin) return resolve({ ok: false, reason: 'openscad CLI 未找到。请先安装：brew install openscad' });
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.stderr.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', () => resolve({ ok: false, reason: '无法执行 openscad（spawn error）' }));
    child.on('close', (code) => {
      if (code === 0 || /openscad/i.test(out)) resolve({ ok: true, version: out.trim(), bin });
      else resolve({ ok: false, reason: `openscad --version 退出码 ${code}` });
    });
  });
}

// Render the given .scad source to a binary STL. Returns { ok, stl, log } or
// { ok:false, error, log }. Times out at 30s by default.
export async function renderToStl(scadSource, { timeoutMs = 30_000 } = {}) {
  const probe = await isAvailable();
  if (!probe.ok) return { ok: false, error: probe.reason, log: '' };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scad-'));
  const scadFile = path.join(tmpDir, `input-${randomUUID()}.scad`);
  const stlFile = path.join(tmpDir, `output-${randomUUID()}.stl`);
  fs.writeFileSync(scadFile, scadSource);

  const bin = locateBinary();
  // -o output.stl input.scad : standard non-GUI export.
  const args = ['-o', stlFile, scadFile];

  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (c) => (log += c.toString('utf8')));
    child.stderr.on('data', (c) => (log += c.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, error: err.message, log });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        cleanup();
        return resolve({ ok: false, error: `渲染超时（>${timeoutMs}ms）`, log });
      }
      if (code !== 0 || !fs.existsSync(stlFile)) {
        cleanup();
        return resolve({ ok: false, error: `openscad 退出码 ${code}`, log });
      }
      try {
        const stl = fs.readFileSync(stlFile);
        cleanup();
        resolve({ ok: true, stl, log });
      } catch (e) {
        cleanup();
        resolve({ ok: false, error: e.message, log });
      }
    });
  });

  function cleanup() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
