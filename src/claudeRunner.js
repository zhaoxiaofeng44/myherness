// One-shot helper around the CLI tool. Spawns a fresh process with
// appropriate arguments for the active CLI tool, parses the output
// and resolves with the final assistant text.
// Used by the memory distiller and the LLM decider — both want a short
// independent inference, not a long-lived conversation.
import { spawn } from 'node:child_process';
import { CliToolManager } from './cliToolManager.js';

const DEFAULT_TIMEOUT_MS = 60_000;

// Shared CLI tool manager instance for one-shot calls
const cliToolManager = new CliToolManager();

// permissionMode: 'plan' is the safest sandbox — Claude can think and reply,
// but cannot execute Bash/Edit/Write etc. We use it for distillation and
// decider calls so a poisoned memory or transcript can't actually do anything.
export async function runClaudeOneShot({
  prompt,
  cwd,
  permissionMode = 'plan',
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('runClaudeOneShot: prompt is required');
  }

  // Build args using the CLI tool manager's adapter
  const args = cliToolManager.buildArgs({
    prompt,
    permissionMode,
    resumeSessionId: null,
    useStdin: false,
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      const cliCommand = cliToolManager.getActiveCommand();
      child = spawn(cliCommand, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error('spawn cli failed: ' + e.message));
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let finalText = '';
    let usage = null;
    let cost = null;
    let resultSubtype = null;
    let settled = false;

    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      try { child.stdout.removeAllListeners(); } catch {}
      try { child.stderr.removeAllListeners(); } catch {}
      if (err) reject(err); else resolve(payload);
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { return; }
      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) finalText += block.text;
        }
      } else if (evt.type === 'result') {
        resultSubtype = evt.subtype;
        usage = evt.usage || null;
        cost = evt.total_cost_usd ?? null;
        if (typeof evt.result === 'string' && evt.result) finalText = evt.result;
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

    child.on('error', (err) => finish(new Error('claude error: ' + err.message)));

    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (code !== 0 && !finalText) {
        return finish(new Error(`claude exited ${code}: ${stderrBuf.trim().slice(0, 500)}`));
      }
      finish(null, { text: finalText, usage, cost, subtype: resultSubtype });
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
      finish(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
  });
}

// Helper: extract the first JSON object/array from a free-text response.
// LLMs sometimes wrap output in markdown fences or add prose; we pull out
// the first balanced {...} or [...] and parse it.
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Try direct parse first.
  try { return JSON.parse(trimmed); } catch {}
  // Strip markdown code fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // Find the first balanced JSON object/array by counting braces.
  for (const open of ['{', '[']) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          try { return JSON.parse(slice); } catch { break; }
        }
      }
    }
  }
  return null;
}
