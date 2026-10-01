// Integrated terminal backend: one node-pty per terminal id, output pumped to
// the window over IPC. Root-agnostic — index.js resolves the spawn cwd (project
// root or scratch) and owns the send/exit plumbing.
import path from 'node:path';
import { existsSync } from 'node:fs';
import pty from 'node-pty';

let seq = 0;
const terms = new Map(); // id -> { proc, shell, cwd, dead, exitCode }

/** VSCode parity default: PowerShell on Windows, $SHELL (else zsh/bash). */
export function defaultShell() {
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    if (existsSync(ps)) return ps;
    return 'cmd.exe';
  }
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // The bridge injects opencode credentials for its own server calls — child
  // shells must not inherit them.
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

export function shellLabel(shell) {
  const base = (shell || '').split(/[\\/]/).pop() || 'shell';
  return base.replace(/\.exe$/i, '');
}

export function list() {
  return [...terms.entries()].map(([id, t]) => ({
    id, pid: t.proc.pid ?? null, shell: t.shell, cwd: t.cwd, dead: t.dead, exitCode: t.exitCode ?? null,
  }));
}

export function create({ shell, cwd, cols = 80, rows = 24 }, hooks = {}) {
  const useShell = shell || defaultShell();
  const proc = pty.spawn(useShell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv(),
  });
  const id = `term:${++seq}:${proc.pid ?? 'x'}`;
  const entry = { proc, shell: useShell, cwd, dead: false, exitCode: null };
  terms.set(id, entry);
  proc.onData((data) => hooks.onData?.(id, data));
  proc.onExit(({ exitCode, signal }) => {
    entry.dead = true;
    entry.exitCode = exitCode ?? null;
    hooks.onExit?.(id, exitCode ?? null, signal ?? null);
  });
  return { id, pid: proc.pid ?? null, shell: useShell, cwd };
}

export function write(id, data) {
  const t = terms.get(id);
  if (!t || t.dead) return false;
  t.proc.write(data);
  return true;
}

export function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t || t.dead) return false;
  try {
    t.proc.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
    return true;
  } catch {
    return false;
  }
}

/** Kill a live terminal, or dispose a dead entry. Returns 'killed' | 'disposed' | false. */
export function kill(id) {
  const t = terms.get(id);
  if (!t) return false;
  if (t.dead) {
    terms.delete(id);
    return 'disposed';
  }
  try {
    t.proc.kill();
  } catch {
    /* already gone */
  }
  return 'killed';
}

export function killAll() {
  for (const [id, t] of terms) {
    if (!t.dead) {
      try {
        t.proc.kill();
      } catch {
        /* noop */
      }
    }
    terms.delete(id);
  }
}
