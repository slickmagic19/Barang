// Source Control view (VSCode SCM parity): branch header + sync actions,
// commit box, Staged/Changes groups with diff/stage/discard, stash, history.
// Talks to the real git through main (simple-git); diffs reuse the Monaco
// diff tab. Decorations feed the explorer badges via decoration().
import { barang } from '../lib/transport';
import { el, copyText } from '../lib/util';
import { iconEl } from './icons';
import { fileIconEl } from './fileIcons';
import { showContextMenu } from './menu';
import { confirmDialog, promptDialog } from './dialog';
import { openDiffTab } from './editor';

export interface GitRepoInfo {
  isRepo: boolean;
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface ScmHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  revealInExplorer(path: string): void;
  refreshExplorer(): void;
  onRepo(info: GitRepoInfo | null): void;
}

interface FileEntry { path: string; index: string; work: string }
interface StashEntry { hash: string; date: string; message: string }
interface LogEntry { hash: string; message: string; author: string; date: string }

const CODE_CLASS: Record<string, string> = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' };
const CODE_LABEL: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Conflict', U: 'Untracked', '?': 'Untracked' };

// Module state (single SCM view per window).
let decoFiles = new Map<string, string>();
let decoDirs = new Set<string>();

/** Explorer badge for a tree path (file exact, dir rolled up). Null = clean. */
export function decoration(rel: string, isDir: boolean): string | null {
  if (!isDir) return decoFiles.get(rel) ?? null;
  if (decoDirs.has(rel) || rel === '.') {
    // Root shows a dot only when something is dirty (avoids noise).
    return rel === '.' ? (decoFiles.size ? '~' : null) : '~';
  }
  return null;
}

export function initScm(host: HTMLElement, hooks: ScmHooks) {
  let info: any = null;
  let log: LogEntry[] = [];
  let stash: StashEntry[] = [];
  let busy = false;

  const head = el('div', { class: 'scm-head' });
  const branchBtn = el('button', { class: 'scm-branch', title: 'Branch — click to switch' }) as HTMLButtonElement;
  const syncBox = el('div', { class: 'scm-sync' });
  const mkHeadBtn = (icon: 'refresh' | 'download' | 'upload' | 'history' | 'plus', title: string, run: () => void) => {
    const b = el('button', { class: 'icon-btn', title }) as HTMLButtonElement;
    b.append(iconEl(icon, 14));
    b.onclick = run;
    syncBox.append(b);
    return b;
  };
  mkHeadBtn('refresh', 'Fetch', () => void netOp('fetch', 'Fetched.'));
  mkHeadBtn('download', 'Pull', () => void netOp('pull', 'Pulled.'));
  mkHeadBtn('upload', 'Push', () => void netOp('push', 'Pushed.'));
  head.append(branchBtn, syncBox);

  const commitBox = el('div', { class: 'scm-commit' });
  const msgInput = el('textarea', { class: 'scm-msg', placeholder: 'Message (Ctrl+Enter to commit)', rows: '2' }) as HTMLTextAreaElement;
  const commitRow = el('div', { class: 'scm-commit-row' });
  const amendLabel = el('label', { class: 'scm-amend' });
  const amendBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  amendLabel.append(amendBox, el('span', {}, 'Amend'));
  const btnCommit = el('button', { class: 'btn btn-primary btn-sm scm-commit-btn' }, 'Commit') as HTMLButtonElement;
  const btnStash = el('button', { class: 'btn btn-sm', title: 'Stash all tracked changes' }, 'Stash') as HTMLButtonElement;
  commitRow.append(amendLabel, btnStash, btnCommit);
  commitBox.append(msgInput, commitRow);

  const groups = el('div', { class: 'scm-groups' });
  host.append(head, commitBox, groups);
  host.classList.add('scm');

  async function git<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return barang().git(op, args) as Promise<T>;
  }

  function setBusy(on: boolean) {
    busy = on;
    host.classList.toggle('is-busy', on);
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    try {
      info = await git('info');
    } catch (e) {
      hooks.toast(`Git status failed: ${(e as Error).message}`, 'error');
      return;
    }
    if (info?.isRepo) {
      try {
        const [l, s] = await Promise.all([
          git<{ all: LogEntry[] }>('log', { n: 12 }),
          git<{ all: StashEntry[] }>('stash-list'),
        ]);
        log = l.all ?? [];
        stash = s.all ?? [];
      } catch {
        log = [];
        stash = [];
      }
    } else {
      log = [];
      stash = [];
    }
    rebuildDeco();
    paint();
    hooks.onRepo(info?.isRepo
      ? {
        isRepo: true, branch: info.branch, tracking: info.tracking ?? null,
        ahead: info.ahead ?? 0, behind: info.behind ?? 0,
        dirty: (info.staged?.length ?? 0) + (info.changes?.length ?? 0) > 0,
      }
      : null);
    hooks.refreshExplorer();
  }

  function rebuildDeco() {
    decoFiles = new Map();
    decoDirs = new Set();
    if (!info?.isRepo) return;
    for (const f of (info.files ?? []) as FileEntry[]) {
      const code = (f.work && f.work !== ' ' ? f.work : f.index) || '';
      const letter = code === '?' ? 'U' : code;
      if (!letter || letter === ' ') continue;
      decoFiles.set(f.path, letter);
      // Roll up so folders (and the root dot) show dirty state.
      let dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      while (true) {
        decoDirs.add(dir);
        if (dir === '.') break;
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.';
      }
    }
  }

  function baseName(p: string): string {
    return p.split('/').pop() || p;
  }

  function dirName(p: string): string {
    return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }

  function badge(code: string): HTMLElement {
    const letter = CODE_CLASS[code] ?? code;
    const b = el('span', { class: `git-badge git-${letter}`, title: CODE_LABEL[code] ?? code }, letter === '?' ? 'U' : letter);
    return b;
  }

  async function openDiff(rel: string): Promise<void> {
    try {
      const d = await git<{ before: string; after: string }>('diff', { path: rel });
      await openDiffTab(rel, d.before, d.after);
    } catch (e) {
      hooks.toast(`Diff failed: ${(e as Error).message}`, 'error');
    }
  }

  async function mutate(op: string, args: Record<string, unknown>, done?: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await git(op, args);
      if (done) hooks.toast(done, 'info');
      await refresh();
      return true;
    } catch (e) {
      hooks.toast(`${op[0].toUpperCase() + op.slice(1)} failed: ${(e as Error).message}`, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function netOp(op: 'fetch' | 'pull' | 'push', done: string): Promise<void> {
    if (busy || !info?.isRepo) return;
    setBusy(true);
    hooks.toast(`${op[0].toUpperCase() + op.slice(1)}ing…`, 'info');
    try {
      await git(op);
      hooks.toast(done, 'info');
      await refresh();
    } catch (e) {
      hooks.toast(`${op[0].toUpperCase() + op.slice(1)} failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function fileRow(e: FileEntry, group: 'staged' | 'changes'): HTMLElement {
    const code = group === 'staged' ? (e.index || '') : (e.work || '');
    const row = el('button', { class: 'scm-row', title: `${e.path} — ${CODE_LABEL[code] ?? code}` }) as HTMLButtonElement;
    row.append(fileIconEl(baseName(e.path), 15));
    row.append(el('span', { class: 'scm-name' }, baseName(e.path)));
    const dir = dirName(e.path);
    if (dir) row.append(el('span', { class: 'scm-dir' }, dir));
    row.append(badge(code));
    const act = el('span', { class: 'scm-row-act', title: group === 'staged' ? 'Unstage' : 'Stage' });
    act.append(iconEl(group === 'staged' ? 'minus' : 'plus', 13));
    (act as HTMLElement).onclick = (ev) => {
      ev.stopPropagation();
      void mutate(group === 'staged' ? 'unstage' : 'stage', { paths: [e.path] });
    };
    row.append(act);
    row.onclick = () => void openDiff(e.path);
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showContextMenu(ev.clientX, ev.clientY, [
        { label: 'Open Diff', icon: 'external', run: () => void openDiff(e.path) },
        group === 'staged'
          ? { label: 'Unstage', icon: 'minus', run: () => void mutate('unstage', { paths: [e.path] }) }
          : { label: 'Stage', icon: 'plus', run: () => void mutate('stage', { paths: [e.path] }) },
        ...(group === 'changes'
          ? [{
            label: 'Discard Changes…', icon: 'trash' as const,
            run: () => void (async () => {
              const ok = await confirmDialog({
                title: 'Discard changes?',
                message: `${e.path} — worktree changes are lost forever.`,
                confirmLabel: 'Discard',
                danger: true,
              });
              if (ok) void mutate('discard', { paths: [e.path] }, `Discarded ${baseName(e.path)}.`);
            })(),
          }]
          : []),
        { sep: true },
        { label: 'Reveal in Explorer', icon: 'folder', run: () => hooks.revealInExplorer(e.path) },
        { label: 'Copy Path', icon: 'clip', run: () => void copyText(e.path).then((ok) => hooks.toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')) },
      ]);
    };
    return row;
  }

  function groupBlock(title: string, count: number, tools: HTMLElement[], rows: HTMLElement[]): HTMLElement {
    const sec = el('div', { class: 'scm-sec' });
    const h = el('div', { class: 'scm-sec-head' });
    h.append(el('span', { class: 'scm-sec-title' }, `${title}`), el('span', { class: 'scm-count' }, String(count)));
    const tbox = el('div', { class: 'scm-sec-tools' });
    tbox.append(...tools);
    h.append(tbox);
    sec.append(h, ...rows);
    return sec;
  }

  function toolBtn(icon: 'plus' | 'minus' | 'refresh', title: string, run: () => void): HTMLElement {
    const b = el('button', { class: 'icon-btn', title }) as HTMLButtonElement;
    b.append(iconEl(icon, 13));
    b.onclick = run;
    return b;
  }

  function paint(): void {
    head.classList.toggle('hidden', !info?.isRepo);
    commitBox.classList.toggle('hidden', !info?.isRepo);
    groups.innerHTML = '';
    if (!info) {
      groups.append(el('div', { class: 'scm-empty' }, 'Loading…'));
      return;
    }
    if (!info.gitFound) {
      const box = el('div', { class: 'scm-empty' });
      box.append(
        iconEl('alert', 22),
        el('div', { class: 'scm-empty-title' }, 'Git not found'),
        el('div', { class: 'scm-empty-sub' }, 'Install Git (git-scm.com) and restart Barang for source control.'),
      );
      groups.append(box);
      return;
    }
    if (!info.isRepo) {
      const box = el('div', { class: 'scm-empty' });
      box.append(
        iconEl('branch', 22),
        el('div', { class: 'scm-empty-title' }, 'Not a git repository'),
        el('div', { class: 'scm-empty-sub' }, 'Track this project with Git to stage, commit, and sync.'),
      );
      const btn = el('button', { class: 'btn btn-primary btn-sm' }, 'Initialize Repository') as HTMLButtonElement;
      btn.onclick = () => void mutate('init', {}, 'Repository initialized.');
      box.append(btn);
      groups.append(box);
      return;
    }
    // Header: branch + ahead/behind.
    branchBtn.innerHTML = '';
    branchBtn.append(iconEl('branch', 13), el('span', {}, info.branch));
    const ab: string[] = [];
    if (info.ahead > 0) ab.push(`↑${info.ahead}`);
    if (info.behind > 0) ab.push(`↓${info.behind}`);
    if (ab.length) branchBtn.append(el('span', { class: 'scm-ab' }, ab.join(' ')));
    branchBtn.title = `Branch: ${info.branch}${info.tracking ? ` → ${info.tracking}` : ' (no upstream)'}`;

    const staged = (info.staged ?? []) as FileEntry[];
    const changes = (info.changes ?? []) as FileEntry[];
    groups.append(groupBlock(
      'Staged Changes', staged.length,
      staged.length ? [toolBtn('minus', 'Unstage all', () => void mutate('unstage', { paths: staged.map((f) => f.path) }, 'Unstaged all.'))] : [],
      staged.length ? staged.map((f) => fileRow(f, 'staged')) : [el('div', { class: 'scm-none' }, 'Nothing staged.')],
    ));
    groups.append(groupBlock(
      'Changes', changes.length,
      changes.length ? [toolBtn('plus', 'Stage all', () => void mutate('stage', { paths: changes.map((f) => f.path) }, 'Staged all.'))] : [],
      changes.length ? changes.map((f) => fileRow(f, 'changes')) : [el('div', { class: 'scm-none' }, 'Working tree clean.')],
    ));
    if (stash.length) {
      groups.append(groupBlock(
        'Stash', stash.length, [],
        stash.map((s, i) => {
          const row = el('button', { class: 'scm-row', title: `${s.hash} · ${s.date}` }) as HTMLButtonElement;
          row.append(iconEl('history', 14));
          row.append(el('span', { class: 'scm-name' }, s.message || `stash@{${i}}`));
          row.onclick = () => void mutate('stash-pop', {}, 'Stash applied.');
          row.oncontextmenu = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            showContextMenu(ev.clientX, ev.clientY, [
              { label: 'Apply Stash', icon: 'check', run: () => void mutate('stash-pop', {}, 'Stash applied.') },
              {
                label: 'Drop Stash…', icon: 'trash', run: () => void (async () => {
                  const ok = await confirmDialog({
                    title: 'Drop stash?',
                    message: `${s.message || s.hash} — dropped stashes cannot be recovered.`,
                    confirmLabel: 'Drop',
                    danger: true,
                  });
                  if (ok) void mutate('stash-drop', {}, 'Stash dropped.');
                })(),
              },
            ]);
          };
          return row;
        }),
      ));
    }
    groups.append(groupBlock(
      'History', log.length, [],
      log.length ? log.map((c) => {
        const row = el('button', { class: 'scm-row scm-hist', title: `${c.hash} · ${c.author} · ${c.date}\n${c.message}` }) as HTMLButtonElement;
        row.append(el('span', { class: 'scm-hash' }, c.hash));
        row.append(el('span', { class: 'scm-name' }, c.message));
        row.onclick = () => void copyText(c.hash).then((ok) => hooks.toast(ok ? 'Hash copied.' : 'Copy failed.', ok ? 'info' : 'error'));
        return row;
      }) : [el('div', { class: 'scm-none' }, 'No commits yet.')],
    ));
  }

  branchBtn.onclick = async (e) => {
    if (!info?.isRepo || busy) return;
    let all: string[] = [];
    try {
      const b = await git<{ current: string; all: string[] }>('branches');
      all = b.all ?? [];
    } catch (err) {
      hooks.toast(`Branches failed: ${(err as Error).message}`, 'error');
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 6, [
      ...all.slice(0, 20).map((n) => ({
        label: n,
        icon: (n === info.branch ? 'check' : 'branch') as 'check' | 'branch',
        disabled: n === info.branch,
        run: () => {
          if (n !== info.branch) void mutate('checkout', { name: n }, `Switched to ${n}.`);
        },
      })),
      { sep: true },
      {
        label: 'New Branch…', icon: 'plus' as const, run: () => void (async () => {
          const name = await promptDialog({ title: 'New branch', placeholder: 'feature/name', confirmLabel: 'Create' });
          if (name) void mutate('create-branch', { name }, `Created ${name}.`);
        })(),
      },
    ]);
  };

  btnCommit.onclick = () => void doCommit();
  msgInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void doCommit();
    }
  });
  btnStash.onclick = () => void (async () => {
    if (busy || !info?.isRepo) return;
    const message = await promptDialog({ title: 'Stash changes', placeholder: 'Stash message (optional)', confirmLabel: 'Stash' });
    if (message === null) return;
    void mutate('stash-push', { message: message || 'barang stash' }, 'Stashed.');
  })();

  async function doCommit(): Promise<void> {
    if (busy || !info?.isRepo) return;
    const message = msgInput.value.trim();
    if (!message && !amendBox.checked) {
      hooks.toast('Commit message is empty.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await git<{ summary?: string }>('commit', { message, amend: amendBox.checked });
      msgInput.value = '';
      amendBox.checked = false;
      hooks.toast(r.summary || 'Committed.', 'info');
      await refresh();
    } catch (e) {
      const m = (e as Error).message;
      hooks.toast(/identity|user\.name|user\.email/i.test(m)
        ? 'Git needs an identity: run git config --global user.name "You" and user.email "you@example.com", then retry.'
        : `Commit failed: ${m}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Keep badges truthful while agents and shells edit behind our back.
  setInterval(() => {
    if (!document.hidden && host.isConnected && !host.classList.contains('hidden') && !busy) void refresh();
  }, 15000);

  return { refresh, hasRepo: () => !!info?.isRepo };
}

export type ScmApi = ReturnType<typeof initScm>;
