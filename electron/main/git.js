// Source-control backend: thin, honest wrapper over the user's real git via
// simple-git (same approach as VS Code — config, SSH, and credentials just
// work). All ops run with GIT_TERMINAL_PROMPT=0 so auth prompts fail fast
// with a readable error instead of hanging the window.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

let gitFound = null; // tri-state cache per boot

async function probeGit() {
  if (gitFound !== null) return gitFound;
  try {
    await simpleGit().version();
    gitFound = true;
  } catch {
    gitFound = false;
  }
  return gitFound;
}

function git(cwd) {
  // User-config env (EDITOR/PAGER/SSH/ASKPASS from installers and dotfiles)
  // is legitimate ambient configuration — allowlist it. Arg-based guards
  // (upload-pack, exec, config paths) stay at full strength.
  return simpleGit({
    baseDir: cwd,
    allowEnvironment: [
      'GIT_TERMINAL_PROMPT',
      'EDITOR', 'VISUAL', 'PAGER',
      'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER',
      'GIT_SSH', 'GIT_SSH_COMMAND',
      'GIT_ASKPASS', 'SSH_ASKPASS',
      'GIT_PROXY_COMMAND', 'GIT_EXTERNAL_DIFF',
    ],
    unsafe: {
      allowUnsafeEditor: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeAskPass: true,
      allowUnsafeGitProxy: true,
      allowUnsafeDiffExternal: true,
    },
  }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
}

function err(e) {
  const msg = e?.message || String(e);
  // Surface the actionable line (auth, identity, conflicts) — simple-git
  // appends full stdio dumps after it.
  const first = msg.split('\n').find((l) => /error|fatal|failed|rejected|unknown|conflict|denied/i.test(l));
  throw new Error((first || msg.split('\n')[0] || msg).trim().slice(0, 400));
}

/** Status snapshot shaped for the SCM view. Never throws for non-repos. */
export async function info(cwd) {
  if (!(await probeGit())) return { gitFound: false, isRepo: false };
  const g = git(cwd);
  let isRepo = false;
  try {
    isRepo = await g.checkIsRepo();
  } catch {
    isRepo = false;
  }
  if (!isRepo) return { gitFound: true, isRepo: false };
  try {
    const [s, repoRoot] = await Promise.all([
      g.status(),
      g.revparse(['--show-toplevel']).catch(() => cwd),
    ]);
    const staged = [];
    const changes = [];
    for (const f of s.files ?? []) {
      const entry = { path: f.path, index: f.index, work: f.working_dir };
      if (f.index && f.index !== ' ' && f.index !== '?') staged.push(entry);
      if (f.working_dir && f.working_dir !== ' ') changes.push(entry);
      if (f.working_dir === '?' && !changes.includes(entry)) changes.push(entry);
    }
    return {
      gitFound: true,
      isRepo: true,
      repoRoot: String(repoRoot).trim(),
      branch: s.current || '(detached)',
      tracking: s.tracking || null,
      ahead: s.ahead || 0,
      behind: s.behind || 0,
      staged,
      changes,
      conflicted: s.conflicted || [],
      files: (s.files ?? []).map((f) => ({ path: f.path, index: f.index, work: f.working_dir })),
    };
  } catch (e) {
    err(e);
  }
}

/** Full-file before/after for the Monaco diff tab (HEAD vs worktree). */
export async function fileDiff(cwd, relPath) {
  const g = git(cwd);
  let before = '';
  try {
    before = await g.show(['HEAD:' + relPath.replace(/\\/g, '/')]);
  } catch {
    before = ''; // new/untracked — VSCode shows all-added vs empty
  }
  if (before.length > 1024 * 1024) throw new Error('File too large to diff (>1MB in HEAD)');
  let after = '';
  try {
    const abs = path.join(cwd, relPath);
    const buf = await fs.readFile(abs);
    if (buf.length > 1024 * 1024) throw new Error('File too large to diff (>1MB on disk)');
    if (buf.includes(0)) throw new Error('Binary file — no text diff available');
    after = buf.toString('utf8');
  } catch (e) {
    if (/large|Binary/.test(e?.message || '')) throw e;
    after = ''; // deleted on disk — VSCode shows all-removed
  }
  return { before, after };
}

export async function stage(cwd, paths) {
  try {
    await git(cwd).add(paths);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function unstage(cwd, paths) {
  try {
    await git(cwd).raw(['reset', 'HEAD', '--', ...paths]);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

/** Discard worktree changes (tracked) or delete (untracked). UI confirms first. */
export async function discard(cwd, paths) {
  try {
    const g = git(cwd);
    const s = await g.status();
    const tracked = [];
    const untracked = [];
    for (const p of paths) {
      const hit = (s.files ?? []).find((f) => f.path === p);
      if (hit && hit.working_dir === '?') untracked.push(p);
      else tracked.push(p);
    }
    if (tracked.length) await g.checkout(['--', ...tracked]);
    for (const p of untracked) {
      try {
        await fs.unlink(path.join(cwd, p));
      } catch {
        /* already gone */
      }
    }
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function commit(cwd, message, amend = false) {
  const msg = String(message || '').trim();
  if (!msg && !amend) throw new Error('Commit message is empty');
  try {
    const args = ['commit'];
    if (amend) args.push('--amend');
    if (msg) args.push('-m', msg);
    else args.push('--allow-empty-message', '-m', '');
    const r = await git(cwd).raw(args);
    return { ok: true, summary: String(r).split('\n')[0].slice(0, 120) };
  } catch (e) {
    err(e);
  }
}

export async function branches(cwd) {
  try {
    const b = await git(cwd).branch();
    return { current: b.current, all: b.all.filter((n) => !n.startsWith('remotes/')) };
  } catch (e) {
    err(e);
  }
}

export async function checkout(cwd, name) {
  try {
    await git(cwd).checkout(name);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function createBranch(cwd, name) {
  const n = String(name || '').trim();
  if (!/^(?!\/|\.|.*\.\.|.*@{|.*[~^:?*[\]\\]).+$/.test(n)) throw new Error(`Invalid branch name: ${n}`);
  try {
    await git(cwd).checkoutBranch(n, 'HEAD');
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function fetchAll(cwd) {
  try {
    await git(cwd).fetch(['--prune']);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function pull(cwd) {
  try {
    const r = await git(cwd).pull();
    return { ok: true, summary: r.summary };
  } catch (e) {
    err(e);
  }
}

export async function push(cwd) {
  try {
    const g = git(cwd);
    try {
      await g.push();
    } catch (e) {
      if (!/no upstream|set-upstream|upstream/i.test(e?.message || '')) throw e;
      // First push of a new branch: set upstream on the first remote.
      const remotes = await g.getRemotes(true);
      const remote = remotes[0]?.name || 'origin';
      const s = await g.status();
      await g.push(remote, s.current, ['--set-upstream']);
    }
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function sync(cwd) {
  try {
    const g = git(cwd);
    await g.fetch(['--prune']);
    const r = await g.pull();
    await push(cwd);
    return { ok: true, summary: r.summary };
  } catch (e) {
    err(e);
  }
}

export async function stashList(cwd) {
  try {
    const r = await git(cwd).stashList();
    return { all: (r.all ?? []).map((s) => ({ hash: s.hash, date: s.date, message: s.message })) };
  } catch (e) {
    err(e);
  }
}

export async function stashPush(cwd, message) {
  try {
    await git(cwd).stash(['push', '-m', String(message || 'barang stash')]);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function stashPop(cwd) {
  try {
    await git(cwd).stash(['pop']);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function stashDrop(cwd) {
  try {
    await git(cwd).stash(['drop']);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

export async function log(cwd, n = 15) {
  try {
    const r = await git(cwd).log({ maxCount: Math.max(1, Math.min(50, n | 0)) });
    return {
      all: (r.all ?? []).map((c) => ({
        hash: c.hash.slice(0, 7), message: c.message.split('\n')[0], author: c.author_name, date: c.date,
      })),
    };
  } catch (e) {
    err(e);
  }
}

export async function init(cwd) {
  try {
    await git(cwd).init();
    return { ok: true };
  } catch (e) {
    err(e);
  }
}
