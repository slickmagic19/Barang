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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // The bridge injects opencode credentials for its own server calls — git
  // children must not inherit them.
  delete env.OPENCODE_SERVER_PASSWORD;
  // CRITICAL scope guard: GIT_CEILING_DIRECTORIES stops git from ascending
  // past the OPENED folder, so a bare subfolder of a repo never sees (or
  // mutates!) the parent's .git. The ceiling is the parent dir itself —
  // cwd stays searchable, everything above is invisible to every op.
  env.GIT_CEILING_DIRECTORIES = path.dirname(cwd);
  return simpleGit({
    baseDir: cwd,
    allowEnvironment: [
      'GIT_TERMINAL_PROMPT',
      'GIT_CEILING_DIRECTORIES',
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
  }).env(env);
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
      files: (s.files ?? []).map((f) => ({ path: f.path, index: f.index, work: f.working_dir, from: f.from ?? null })),
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

export async function commit(cwd, message, amend = false, signoff = false) {
  const msg = String(message || '').trim();
  if (!msg && !amend) throw new Error('Commit message is empty');
  try {
    const args = ['commit'];
    if (amend) args.push('--amend');
    if (signoff) args.push('--signoff');
    if (msg) args.push('-m', msg);
    else args.push('--allow-empty-message', '-m', '');
    const r = await git(cwd).raw(args);
    return { ok: true, summary: String(r).split('\n')[0].slice(0, 120) };
  } catch (e) {
    err(e);
  }
}

/** VSCode "Commit All": stage tracked modifications/deletions (git commit -a
 *  semantics — untracked files stay) and commit. */
export async function commitAll(cwd, message, signoff = false) {
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Commit message is empty');
  try {
    const g = git(cwd);
    await g.add(['-u']);
    const args = ['commit'];
    if (signoff) args.push('--signoff');
    args.push('-m', msg);
    const r = await g.raw(args);
    return { ok: true, summary: String(r).split('\n')[0].slice(0, 120) };
  } catch (e) {
    err(e);
  }
}

/** VSCode "Undo Last Commit": keep worktree + index, drop the commit. */
export async function undoCommit(cwd) {
  try {
    await git(cwd).reset(['--soft', 'HEAD~1']);
    return { ok: true };
  } catch (e) {
    err(e);
  }
}

/** Resolve a conflicted file by side (whole-file granularity, like taking
 *  one side everywhere). ours = HEAD, theirs = incoming, both = concat. */
export async function resolveConflict(cwd, relPath, side) {
  if (!['ours', 'theirs', 'both'].includes(side)) throw new Error(`Bad side: ${side}`);
  const abs = path.join(cwd, relPath);
  let text;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    throw new Error(`Cannot read ${relPath}`);
  }
  if (!/^<{7} /m.test(text)) throw new Error(`${relPath} has no conflict markers`);
  const out = [];
  let ours = [];
  let theirs = [];
  let state = 'normal'; // normal | ours | theirs
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ')) {
      if (state !== 'normal') throw new Error(`Nested conflict markers in ${relPath}`);
      state = 'ours';
      ours = [];
      theirs = [];
    } else if (line === '=======' && state === 'ours') {
      state = 'theirs';
    } else if (line.startsWith('>>>>>>> ') && state === 'theirs') {
      if (side === 'ours' || side === 'both') out.push(...ours);
      if (side === 'theirs' || side === 'both') out.push(...theirs);
      state = 'normal';
    } else if (state === 'ours') {
      ours.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    } else {
      out.push(line);
    }
  }
  if (state !== 'normal') throw new Error(`Unterminated conflict block in ${relPath}`);
  await fs.writeFile(abs, out.join('\n'), 'utf8');
  // Resolved files stage immediately (VSCode marks them resolved).
  await git(cwd).add([relPath]);
  return { ok: true };
}

/** Stage modified-side line ranges (VSCode "Stage Selected Ranges").
 *  Whole intersecting hunks are staged (U0 diff, headers recomputed). Pure
 *  deletions (no modified-side lines) need whole-file staging instead. */
export async function stageRanges(cwd, relPath, ranges) {
  const sel = (ranges ?? [])
    .map((r) => ({ start: Math.max(1, r.start | 0), end: Math.max(1, r.end | 0) }))
    .filter((r) => r.end >= r.start);
  if (!sel.length) throw new Error('No lines selected');
  const g = git(cwd);
  let diff;
  try {
    diff = await g.diff(['-U0', '--', relPath]);
  } catch (e) {
    err(e);
  }
  if (!diff || !diff.trim()) throw new Error('No unstaged changes in this file');
  const inSel = (n) => sel.some((r) => n >= r.start && n <= r.end);
  const hunks = [];
  let cur = null;
  for (const line of String(diff).split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = {
        oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (cur && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) cur.lines.push(line);
  }
  const kept = [];
  for (const h of hunks) {
    let n = h.newStart;
    const keepPlus = [];
    for (const line of h.lines) {
      if (line.startsWith('+')) {
        keepPlus.push(inSel(n));
        n++;
      } else if (line.startsWith(' ')) {
        n++;
      }
    }
    if (!keepPlus.some(Boolean)) continue; // untouched hunk
    // Kept hunk: selected additions + ALL deletions (a del/add pair is one
    // logical change) + context.
    let oKept = 0;
    let nKept = 0;
    const out = [];
    let pi = 0;
    n = h.newStart;
    for (const line of h.lines) {
      if (line.startsWith('+')) {
        if (keepPlus[pi]) {
          out.push(line);
          nKept++;
        }
        pi++;
        n++;
      } else if (line.startsWith('-')) {
        out.push(line);
        oKept++;
      } else {
        out.push(line);
        oKept++;
        nKept++;
        n++;
      }
    }
    kept.push(`@@ -${h.oldStart},${oKept} +${h.newStart},${nKept} @@`);
    kept.push(...out);
  }
  if (!kept.length) throw new Error('Selection holds no stageable additions (pure deletions need whole-file stage)');
  const patch = `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n${kept.join('\n')}\n`;
  const tmp = path.join(cwd, `.barang-stage-${Date.now()}.patch`);
  try {
    await fs.writeFile(tmp, patch, 'utf8');
    await g.raw(['apply', '--cached', '--unidiff-zero', tmp]);
    return { ok: true, hunks: kept.filter((l) => l.startsWith('@@')).length };
  } catch (e) {
    err(e);
  } finally {
    try {
      await fs.unlink(tmp);
    } catch {
      /* noop */
    }
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

/** Local identity for throwaway repos (key allowlisted — never global). */
export async function setConfig(cwd, key, value) {
  if (!['user.name', 'user.email'].includes(key)) throw new Error(`config key not allowed: ${key}`);
  try {
    await git(cwd).addConfig(key, String(value), false, 'local');
    return { ok: true };
  } catch (e) {
    err(e);
  }
}
