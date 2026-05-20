// Per-session interactive PTY. One bash process per Claude Code session,
// lazily spawned on first input/attach. Output is streamed to all SSE
// clients via the existing broadcast channel; a small ring buffer lets
// a freshly-attached client replay recent output so the screen isn't
// blank on page refresh.
import * as pty from 'node-pty';

const REPLAY_BUFFER_BYTES = 64 * 1024;

export class TerminalManager {
  constructor({ broadcast }) {
    this.broadcast = broadcast;
    this.terminals = new Map(); // sessionId -> { pty, buffer, cols, rows }
  }

  ensure(session, { cols = 80, rows = 24 } = {}) {
    if (!session) throw new Error('session required');
    let t = this.terminals.get(session.id);
    if (t && t.pty) return t;
    const shell = process.env.SHELL || '/bin/bash';
    const child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd: session.workdir,
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    t = { pty: child, buffer: '', cols, rows };
    this.terminals.set(session.id, t);
    child.onData((data) => {
      t.buffer = (t.buffer + data).slice(-REPLAY_BUFFER_BYTES);
      this.broadcast('term:data', { sessionId: session.id, data });
    });
    child.onExit(({ exitCode, signal }) => {
      const note = `\r\n\x1b[33m[shell exited: code=${exitCode} signal=${signal || 0}]\x1b[0m\r\n`;
      t.buffer = (t.buffer + note).slice(-REPLAY_BUFFER_BYTES);
      this.broadcast('term:data', { sessionId: session.id, data: note });
      this.broadcast('term:exit', { sessionId: session.id, exitCode, signal });
      this.terminals.delete(session.id);
    });
    return t;
  }

  write(sessionId, data) {
    const t = this.terminals.get(sessionId);
    if (!t || !t.pty) return false;
    t.pty.write(data);
    return true;
  }

  resize(sessionId, cols, rows) {
    const t = this.terminals.get(sessionId);
    if (!t || !t.pty) return false;
    try {
      t.pty.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
      t.cols = cols; t.rows = rows;
      return true;
    } catch {
      return false;
    }
  }

  replay(sessionId) {
    const t = this.terminals.get(sessionId);
    return t?.buffer || '';
  }

  kill(sessionId) {
    const t = this.terminals.get(sessionId);
    if (!t) return false;
    try { t.pty.kill(); } catch {}
    this.terminals.delete(sessionId);
    return true;
  }

  killAll() {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }
}
