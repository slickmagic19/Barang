// Source Control view, VSCode-faithful: title row (refresh, More Actions),
// branch/sync row, commit input with history + draft, Commit split button,
// Merge / Staged Changes / Changes groups (flat or tree, sortable), stash +
// history sections (toggleable), explorer badges, statusbar repo state.
// Talks to the real git through main (simple-git); diffs reuse the Monaco
// diff tab (which also hosts "Stage Selected Ranges").
import { barang } from '../lib/transport';
import { el, copyText } from '../lib/util';
import { iconEl } from './icons';
import { fileIconEl } from './fileIcons';
import { showContextMenu } from './menu';
import { confirmDialog, promptDialog } from './dialog';
import { openDiffTab, registerStageRangesAction } from './editor';

export interface GitRepoInfo {
  isRepo: boolean;
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  total: number; // staged + unstaged files (activity badge)
}

export interface ScmHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  onOpenFile(path: string, opts?: { focus?: boolean }): void;
  revealInExplorer(path: string): void;
  refreshExplorer(): void;
  onRepo(info: GitRepoInfo | null): void;
}

interface FileEntry { path: string; index: string; work: string; from?: string | null }
interface StashEntry { hash: string; date: string; message: string }
interface LogEntry { hash: string; message: string; author: string; date: string }

type SortMode = 'status' | 'name' | 'path';

// Exact VSCode Dark+ git decoration colors (theme color reference).
const GIT_CSS = `
.git-A,.git-R{color:#81b88b}.git-M{color:#e2c08d}.git-D{color:#c74e39}
.git-U{color:#73c991}.git-C{color:#e4676b}.git-\\?{color:#73c991}`;
let gitCssInjected = false;

const CODE_LABEL: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Conflict', U: 'Untracked', '?': 'Untracked' };

// Module state (single SCM view per window).
let decoFiles = new Map<string, string>();
let decoDirs = new Set<string>();

/** Explorer badge for a tree path (file exact, dir rolled up). Null = clean. */
export function decoration(rel: string, isDir: boolean): string | null {
  if (!isDir) return decoFiles.get(rel) ?? null;
  if (decoDirs.has(rel)) return '~';
  return null;
}

const LS_TREE = 'barang:scm-tree';
const LS_SORT = 'barang:scm-sort';
const LS_STASH = 'barang:scm-show-stash';
const LS_HIST = 'barang:scm-show-history';
const LS_MSG_HIST = 'barang:scm-msg-hist';
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export function initScm(host: HTMLElement, hooks: ScmHooks) {
  if (!gitCssInjected) {
    gitCssInjected = true;
    const style = document.createElement('style');
    style.textContent = GIT_CSS;
    document.head.append(style);
  }
  let info: any = null;
  let log: LogEntry[] = [];
  let stash: StashEntry[] = [];
  let busy = false;
  let amendOn = false;
  let signoffOn = false;
  let treeMode = lsGet(LS_TREE) === '1';
  let sortMode: SortMode = (lsGet(LS_SORT) as SortMode) || 'status';
  if (!['status', 'name', 'path'].includes(sortMode)) sortMode = 'status';
  let showStash = lsGet(LS_STASH) !== '0';
  let showHistory = lsGet(LS_HIST) !== '0';
  let msgHist: string[] = [];
  try {
    msgHist = JSON.parse(lsGet(LS_MSG_HIST) || '[]').filter((s: unknown) => typeof s === 'string').slice(-20);
  } catch {
    msgHist = [];
  }
  let histIdx = -1; // -1 = draft
  const collapsed = new Set<string>();

  // --- chrome -----------------------------------------------------------
  const titleRow = el('div', { class: 'scm-title' });
  titleRow.append(el('span', { class: 'scm-title-text' }, 'SOURCE CONTROL'));
  const titleActs = el('div', { class: 'scm-title-acts' });
  const btnRefresh = el('button', { class: 'icon-btn', title: 'Refresh' }) as HTMLButtonElement;
  btnRefresh.append(iconEl('refresh', 14));
  btnRefresh.onclick = () => void refresh();
  const btnMore = el('button', { class: 'icon-btn', title: 'Views and More Actions…' }) as HTMLButtonElement;
  btnMore.append(iconEl('meatball', 16));
  titleRow.append(titleActs);
  titleActs.append(btnRefresh, btnMore);

  const repoRow = el('div', { class: 'scm-repo' });
  const branchBtn = el('button', { class: 'scm-branch', title: 'Select branch (click to switch)' }) as HTMLButtonElement;
  const repoActs = el('div', { class: 'scm-sync' });
  const mkBtn = (icon: 'sync' | 'refresh' | 'download' | 'upload' | 'plus', title: string, run: () => void, cls = '') => {
    const b = el('button', { class: `icon-btn ${cls}`.trim(), title }) as HTMLButtonElement;
    b.append(iconEl(icon, 14));
    b.onclick = run;
    repoActs.append(b);
    return b;
  };
  const btnNewBranch = mkBtn('plus', 'Create New Branch…', () => void newBranchFlow());
  const btnSync = mkBtn('sync', 'Sync changes (fetch, pull, push)', () => void netOp('sync', 'Synced.'));
  const btnFetch = mkBtn('refresh', 'Fetch', () => void netOp('fetch', 'Fetched.'));
  const btnPull = mkBtn('download', 'Pull', () => void netOp('pull', 'Pulled.'));
  const btnPush = mkBtn('upload', 'Push', () => void netOp('push', 'Pushed.'));
  const btnPublish = mkBtn('upload', 'Publish branch (push + set upstream)', () => void netOp('push', 'Published.'), 'scm-publish hidden');
  void btnNewBranch; void btnSync; void btnFetch; void btnPull; void btnPush;
  repoRow.append(branchBtn, repoActs);

  const commitBox = el('div', { class: 'scm-commit' });
  const msgInput = el('textarea', { class: 'scm-msg', rows: '2' }) as HTMLTextAreaElement;
  msgInput.placeholder = 'Message';
  const commitRow = el('div', { class: 'scm-commit-row' });
  const splitBtn = el('div', { class: 'scm-split' });
  const btnCommit = el('button', { class: 'btn btn-primary btn-sm scm-commit-btn' }, 'Commit') as HTMLButtonElement;
  const btnCommitMenu = el('button', { class: 'btn btn-primary btn-sm scm-commit-chev', title: 'Commit options' }) as HTMLButtonElement;
  btnCommitMenu.append(iconEl('chevD', 13));
  splitBtn.append(btnCommit, btnCommitMenu);
  commitRow.append(el('span', { class: 'scm-commit-hint' }, 'Ctrl+Enter'), splitBtn);
  commitBox.append(msgInput, commitRow);

  const groups = el('div', { class: 'scm-groups' });
  host.append(titleRow, repoRow, commitBox, groups);
  host.classList.add('scm');

  async function git<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return barang().git(op, args) as Promise<T>;
  }

  function setBusy(on: boolean) {
    busy = on;
    host.classList.toggle('is-busy', on);
  }

  // Overlapping refreshes (interval + focus + post-mutation) race: a slow
  // earlier refresh must never paint over a fresher one (stale-paint-wins
  // shows ghost staged rows). Generation guard, same as the explorer.
  let refreshSeq = 0;

  function draftKey(): string {
    return `barang:scm-draft:${info?.repoRoot ?? 'none'}`;
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    const my = ++refreshSeq;
    try {
      info = await git('info');
    } catch (e) {
      if (my !== refreshSeq) return;
      hooks.toast(`Git status failed: ${(e as Error).message}`, 'error');
      return;
    }
    if (my !== refreshSeq) return; // superseded — never touch the DOM
    if (info?.isRepo) {
      try {
        const [l, s] = await Promise.all([
          git<{ all: LogEntry[] }>('log', { n: 12 }),
          git<{ all: StashEntry[] }>('stash-list'),
        ]);
        if (my !== refreshSeq) return;
        log = l.all ?? [];
        stash = s.all ?? [];
      } catch {
        if (my !== refreshSeq) return;
        log = [];
        stash = [];
      }
      msgInput.placeholder = `Message (Ctrl+Enter to commit on '${info.branch}')`;
      if (!msgInput.value) {
        try {
          msgInput.value = localStorage.getItem(draftKey()) ?? '';
        } catch {
          /* noop */
        }
      }
    } else {
      log = [];
      stash = [];
    }
    rebuildDeco();
    paint();
    const staged = (info?.staged ?? []).length;
    const changes = (info?.changes ?? []).length;
    hooks.onRepo(info?.isRepo
      ? {
        isRepo: true, branch: info.branch, tracking: info.tracking ?? null,
        ahead: info.ahead ?? 0, behind: info.behind ?? 0,
        dirty: staged + changes > 0, total: staged + changes,
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
      let dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      while (true) {
        decoDirs.add(dir);
        if (dir === '.') break;
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.';
      }
    }
  }

  // --- rows ---------------------------------------------------------------
  function baseName(p: string): string {
    return p.split('/').pop() || p;
  }

  function dirName(p: string): string {
    return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }

  function badge(code: string): HTMLElement {
    const letter = code === '?' ? 'U' : code;
    return el('span', { class: `git-badge git-${letter}`, title: CODE_LABEL[code] ?? code }, letter);
  }

  async function openDiff(rel: string): Promise<void> {
    try {
      const d = await git<{ before: string; after: string }>('diff', { path: rel });
      await openDiffTab(rel, d.before, d.after, 'git');
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

  async function netOp(op: 'fetch' | 'pull' | 'push' | 'sync', done: string): Promise<void> {
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

  async function discardFiles(paths: string[]): Promise<void> {
    if (!paths.length || busy) return;
    const ok = await confirmDialog({
      title: paths.length === 1 ? 'Discard changes?' : `Discard ${paths.length} files?`,
      message: paths.length === 1
        ? `${paths[0]} — worktree changes are lost forever.`
        : `${paths.length} files — worktree changes are lost forever. (Untracked files are never touched by Discard All.)`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (ok) void mutate('discard', { paths }, paths.length === 1 ? `Discarded ${baseName(paths[0])}.` : `Discarded ${paths.length} files.`);
  }

  function sortFiles(list: FileEntry[], group: 'staged' | 'changes'): FileEntry[] {
    const codeOf = (f: FileEntry) => (group === 'staged' ? f.index : f.work) || '';
    const arr = [...list];
    if (sortMode === 'name') arr.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    else if (sortMode === 'path') arr.sort((a, b) => a.path.localeCompare(b.path));
    else arr.sort((a, b) => codeOf(a).localeCompare(codeOf(b)) || a.path.localeCompare(b.path));
    return arr;
  }

  function fileRow(e: FileEntry, group: 'staged' | 'changes'): HTMLElement {
    const code = group === 'staged' ? (e.index || '') : (e.work || '');
    const row = el('button', { class: 'scm-row', title: `${e.path} — ${CODE_LABEL[code] ?? code}` }) as HTMLButtonElement;
    row.append(fileIconEl(baseName(e.path), 15));
    row.append(el('span', { class: 'scm-name' }, baseName(e.path)));
    row.append(el('span', { class: 'scm-dir' }, e.from ? `${e.from} → ${dirName(e.path)}` : dirName(e.path)));
    row.append(badge(code));
    const acts = el('span', { class: 'scm-row-acts' });
    const openBtn = el('span', { class: 'scm-row-act', title: 'Open File' });
    openBtn.append(iconEl('external', 13));
    (openBtn as HTMLElement).onclick = (ev) => {
      ev.stopPropagation();
      hooks.onOpenFile(e.path, { focus: true });
    };
    const stageBtn = el('span', { class: 'scm-row-act', title: group === 'staged' ? 'Unstage Changes' : 'Stage Changes' });
    stageBtn.append(iconEl(group === 'staged' ? 'minus' : 'plus', 13));
    (stageBtn as HTMLElement).onclick = (ev) => {
      ev.stopPropagation();
      void mutate(group === 'staged' ? 'unstage' : 'stage', { paths: [e.path] });
    };
    acts.append(openBtn, stageBtn);
    if (group === 'changes') {
      const discBtn = el('span', { class: 'scm-row-act', title: 'Discard Changes' });
      discBtn.append(iconEl('discard', 13));
      (discBtn as HTMLElement).onclick = (ev) => {
        ev.stopPropagation();
        void discardFiles([e.path]);
      };
      acts.append(discBtn);
    }
    row.append(acts);
    row.onclick = () => void openDiff(e.path);
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showContextMenu(ev.clientX, ev.clientY, [
        { label: 'Open Changes', icon: 'external', run: () => void openDiff(e.path) },
        { label: 'Open File', icon: 'file', run: () => hooks.onOpenFile(e.path, { focus: true }) },
        group === 'staged'
          ? { label: 'Unstage Changes', icon: 'minus', run: () => void mutate('unstage', { paths: [e.path] }) }
          : { label: 'Stage Changes', icon: 'plus', run: () => void mutate('stage', { paths: [e.path] }) },
        ...(group === 'changes'
          ? [{ label: 'Discard Changes…', icon: 'trash' as const, run: () => void discardFiles([e.path]) }]
          : []),
        { sep: true },
        { label: 'Reveal in Explorer', icon: 'folder', run: () => hooks.revealInExplorer(e.path) },
        { label: 'Copy Path', icon: 'clip', run: () => void copyText(e.path).then((ok) => hooks.toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')) },
      ]);
    };
    return row;
  }

  function conflictRow(cpath: string): HTMLElement {
    const row = el('button', { class: 'scm-row', title: `${cpath} — Merge conflict` }) as HTMLButtonElement;
    row.append(fileIconEl(baseName(cpath), 15));
    row.append(el('span', { class: 'scm-name' }, baseName(cpath)));
    row.append(el('span', { class: 'scm-dir' }, dirName(cpath)));
    row.append(badge('C'));
    const acts = el('span', { class: 'scm-row-acts' });
    const mk = (title: string, side: 'ours' | 'theirs' | 'both') => {
      const b = el('span', { class: 'scm-row-act scm-resolve', title });
      b.append(el('span', { class: 'scm-resolve-label' }, side === 'ours' ? 'Current' : side === 'theirs' ? 'Incoming' : 'Both'));
      (b as HTMLElement).onclick = (ev) => {
        ev.stopPropagation();
        void mutate('resolve-conflict', { path: cpath, side }, `Resolved ${baseName(cpath)} (${title.toLowerCase()}).`);
      };
      return b;
    };
    acts.append(mk('Accept Current', 'ours'), mk('Accept Incoming', 'theirs'), mk('Accept Both', 'both'));
    row.append(acts);
    row.onclick = () => void openDiff(cpath);
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showContextMenu(ev.clientX, ev.clientY, [
        { label: 'Open Changes', icon: 'external', run: () => void openDiff(cpath) },
        { label: 'Accept Current', icon: 'check', run: () => void mutate('resolve-conflict', { path: cpath, side: 'ours' }) },
        { label: 'Accept Incoming', icon: 'check', run: () => void mutate('resolve-conflict', { path: cpath, side: 'theirs' }) },
        { label: 'Accept Both', icon: 'check', run: () => void mutate('resolve-conflict', { path: cpath, side: 'both' }) },
        { sep: true },
        { label: 'Reveal in Explorer', icon: 'folder', run: () => hooks.revealInExplorer(cpath) },
      ]);
    };
    return row;
  }

  function groupBlock(title: string, count: number, tools: HTMLElement[], body: HTMLElement[]): HTMLElement {
    const sec = el('div', { class: 'scm-sec' });
    const h = el('div', { class: 'scm-sec-head' });
    h.append(el('span', { class: 'scm-sec-title' }, title), el('span', { class: 'scm-count' }, String(count)));
    const tbox = el('div', { class: 'scm-sec-tools' });
    tbox.append(...tools);
    h.append(tbox);
    sec.append(h, ...body);
    return sec;
  }

  function toolBtn(icon: 'plus' | 'minus' | 'discard', title: string, run: () => void): HTMLElement {
    const b = el('button', { class: 'icon-btn', title }) as HTMLButtonElement;
    b.append(iconEl(icon, 13));
    b.onclick = run;
    return b;
  }

  /** Flat rows, or tree grouped by directory (VSCode View as Tree). */
  function fileList(list: FileEntry[], group: 'staged' | 'changes'): HTMLElement[] {
    const sorted = sortFiles(list, group);
    if (!treeMode) return sorted.map((f) => fileRow(f, group));
    const out: HTMLElement[] = [];
    const byDir = new Map<string, FileEntry[]>();
    for (const f of sorted) {
      const d = dirName(f.path) || '.';
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d)!.push(f);
    }
    const dirs = [...byDir.keys()].sort();
    for (const d of dirs) {
      const files = byDir.get(d)!;
      if (d === '.') {
        out.push(...files.map((f) => fileRow(f, group)));
        continue;
      }
      const collapsedNow = collapsed.has(`${group}:${d}`);
      const frow = el('button', { class: 'scm-row scm-dir-row' }) as HTMLButtonElement;
      const tw = el('span', { class: `tw${collapsedNow ? '' : ' open'}` });
      tw.append(iconEl('chevR', 12));
      frow.append(tw, iconEl('folder', 14), el('span', { class: 'scm-name' }, d));
      const dAct = el('span', { class: 'scm-row-acts' });
      const dStage = el('span', { class: 'scm-row-act', title: group === 'staged' ? 'Unstage Folder' : 'Stage Folder' });
      dStage.append(iconEl(group === 'staged' ? 'minus' : 'plus', 13));
      (dStage as HTMLElement).onclick = (ev) => {
        ev.stopPropagation();
        void mutate(group === 'staged' ? 'unstage' : 'stage', { paths: files.map((f) => f.path) });
      };
      dAct.append(dStage);
      frow.append(dAct);
      frow.onclick = () => {
        if (collapsed.has(`${group}:${d}`)) collapsed.delete(`${group}:${d}`);
        else collapsed.add(`${group}:${d}`);
        paint();
      };
      out.push(frow);
      if (!collapsedNow) {
        const sub = el('div', { class: 'scm-tree-sub' });
        sub.append(...files.map((f) => fileRow(f, group)));
        out.push(sub);
      }
    }
    return out;
  }

  // --- paint ----------------------------------------------------------------
  function paint(): void {
    const isRepo = !!info?.isRepo;
    titleRow.classList.toggle('hidden', !isRepo && !info);
    repoRow.classList.toggle('hidden', !isRepo);
    commitBox.classList.toggle('hidden', !isRepo);
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
    if (!isRepo) {
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
    branchBtn.innerHTML = '';
    branchBtn.append(iconEl('branch', 13), el('span', {}, info.branch));
    const ab: string[] = [];
    if (info.ahead > 0) ab.push(`↑${info.ahead}`);
    if (info.behind > 0) ab.push(`↓${info.behind}`);
    if (ab.length) branchBtn.append(el('span', { class: 'scm-ab' }, ab.join(' ')));
    branchBtn.title = `Branch: ${info.branch}${info.tracking ? ` → ${info.tracking}` : ' (no upstream)'}`;
    btnPublish.classList.toggle('hidden', !!info.tracking);

    const conflicted: string[] = info.conflicted ?? [];
    const cSet = new Set(conflicted);
    const staged = sortFiles(((info.staged ?? []) as FileEntry[]).filter((f) => !cSet.has(f.path)), 'staged');
    const changes = sortFiles(((info.changes ?? []) as FileEntry[]).filter((f) => !cSet.has(f.path)), 'changes');
    if (conflicted.length) {
      groups.append(groupBlock(
        'Merge Changes', conflicted.length, [],
        conflicted.map((p) => conflictRow(p)),
      ));
    }
    groups.append(groupBlock(
      'Staged Changes', staged.length,
      staged.length ? [toolBtn('minus', 'Unstage All Changes', () => void mutate('unstage', { paths: staged.map((f) => f.path) }, 'Unstaged all.'))] : [],
      staged.length ? fileList(staged, 'staged') : [el('div', { class: 'scm-none' }, 'Nothing staged.')],
    ));
    const trackedChanges = changes.filter((f) => (f.work || '') !== '?' && (f.work || '') !== 'U');
    groups.append(groupBlock(
      'Changes', changes.length,
      changes.length ? [
        toolBtn('plus', 'Stage All Changes', () => void mutate('stage', { paths: changes.map((f) => f.path) }, 'Staged all.')),
        ...(trackedChanges.length ? [toolBtn('discard', 'Discard All Changes', () => void discardFiles(trackedChanges.map((f) => f.path)))] : []),
      ] : [],
      changes.length ? fileList(changes, 'changes') : [el('div', { class: 'scm-none' }, 'Working tree clean.')],
    ));
    if (showStash && stash.length) {
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
    if (showHistory) {
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
  }

  // --- menus ------------------------------------------------------------------
  async function newBranchFlow(): Promise<void> {
    if (!info?.isRepo || busy) return;
    const name = await promptDialog({ title: 'New branch', placeholder: 'feature/name', confirmLabel: 'Create' });
    if (name) void mutate('create-branch', { name }, `Created ${name}.`);
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
        label: 'New Branch…', icon: 'plus' as const, run: () => void newBranchFlow(),
      },
    ]);
  };

  btnMore.onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 6, [
      { label: 'Commit', icon: 'check', run: () => void doCommit('staged') },
      { label: 'Commit All', icon: 'check', run: () => void doCommit('all') },
      { label: 'Undo Last Commit', icon: 'discard', run: () => void undoLast() },
      { sep: true },
      { label: 'Stash Changes…', icon: 'history', run: () => void stashPushFlow() },
      { label: 'Pop Latest Stash', icon: 'check', disabled: !stash.length, run: () => void mutate('stash-pop', {}, 'Stash applied.') },
      { sep: true },
      { label: 'Publish Branch', icon: 'upload', disabled: !info?.isRepo || !!info?.tracking, run: () => void netOp('push', 'Published.') },
      { sep: true },
      { label: `View as ${treeMode ? 'List' : 'Tree'}`, icon: 'file', run: () => { treeMode = !treeMode; lsSet(LS_TREE, treeMode ? '1' : '0'); paint(); } },
      {
        label: `Sort by ${sortMode === 'name' ? 'Path' : sortMode === 'path' ? 'Status' : 'Name'}`,
        icon: 'file',
        run: () => {
          sortMode = sortMode === 'name' ? 'path' : sortMode === 'path' ? 'status' : 'name';
          lsSet(LS_SORT, sortMode);
          paint();
        },
      },
      { label: `${showStash ? '✓ ' : ''}Show Stash`, icon: 'history', run: () => { showStash = !showStash; lsSet(LS_STASH, showStash ? '1' : '0'); paint(); } },
      { label: `${showHistory ? '✓ ' : ''}Show History`, icon: 'history', run: () => { showHistory = !showHistory; lsSet(LS_HIST, showHistory ? '1' : '0'); paint(); } },
      { sep: true },
      { label: 'Refresh', icon: 'refresh', run: () => void refresh() },
    ]);
  };

  async function undoLast(): Promise<void> {
    if (busy || !info?.isRepo) return;
    const ok = await confirmDialog({
      title: 'Undo last commit?',
      message: 'The commit is removed but its changes stay staged (soft reset).',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (ok) void mutate('undo-commit', {}, 'Last commit undone (changes kept).');
  }

  function stashPushFlow(): void {
    void (async () => {
      if (busy || !info?.isRepo) return;
      const message = await promptDialog({ title: 'Stash changes', placeholder: 'Stash message (optional)', confirmLabel: 'Stash' });
      if (message === null) return;
      void mutate('stash-push', { message: message || 'barang stash' }, 'Stashed.');
    })();
  }

  // --- commit -------------------------------------------------------------------
  btnCommit.onclick = () => void doCommit('staged');
  btnCommitMenu.onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 6, [
      { label: 'Commit', icon: 'check', run: () => void doCommit('staged') },
      { label: 'Commit All', icon: 'check', run: () => void doCommit('all') },
      { sep: true },
      { label: `${amendOn ? '✓ ' : ''}Amend Last Commit`, icon: 'pencil', run: () => { amendOn = !amendOn; } },
      { label: `${signoffOn ? '✓ ' : ''}Sign Off`, icon: 'pencil', run: () => { signoffOn = !signoffOn; } },
    ]);
  };
  msgInput.addEventListener('input', () => {
    histIdx = -1;
    try {
      localStorage.setItem(draftKey(), msgInput.value);
    } catch {
      /* noop */
    }
  });
  msgInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void doCommit('staged');
    } else if (e.key === 'ArrowUp' && msgInput.selectionStart === 0 && msgHist.length) {
      // VSCode input history: Up at the top recalls older messages.
      e.preventDefault();
      histIdx = histIdx < 0 ? msgHist.length - 1 : Math.max(0, histIdx - 1);
      msgInput.value = msgHist[histIdx] ?? '';
    } else if (e.key === 'ArrowDown' && msgInput.selectionEnd === msgInput.value.length && histIdx >= 0) {
      e.preventDefault();
      histIdx++;
      msgInput.value = histIdx >= msgHist.length ? '' : (msgHist[histIdx] ?? '');
      if (histIdx >= msgHist.length) histIdx = -1;
    }
  });

  async function doCommit(mode: 'staged' | 'all'): Promise<void> {
    if (busy || !info?.isRepo) return;
    const message = msgInput.value.trim();
    if (!message && !amendOn) {
      hooks.toast('Commit message is empty.', 'error');
      return;
    }
    setBusy(true);
    try {
      const op = mode === 'all' ? 'commit-all' : 'commit';
      const r = await git<{ summary?: string }>(op, { message, amend: amendOn, signoff: signoffOn });
      if (message && !msgHist.includes(message)) {
        msgHist.push(message);
        lsSet(LS_MSG_HIST, JSON.stringify(msgHist.slice(-20)));
      }
      histIdx = -1;
      msgInput.value = '';
      try {
        localStorage.removeItem(draftKey());
      } catch {
        /* noop */
      }
      amendOn = false;
      signoffOn = false;
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

  // Diff-editor action: stage the selected modified-side lines of a git diff.
  registerStageRangesAction(({ file, start, end }) => {
    void (async () => {
      if (busy) return;
      setBusy(true);
      try {
        const r = await git<{ hunks?: number }>('stage-ranges', { path: file, ranges: [{ start, end }] });
        hooks.toast(`Staged ${r.hunks ?? 1} hunk${(r.hunks ?? 1) === 1 ? '' : 's'} from ${baseName(file)}.`, 'info');
        await refresh();
      } catch (e) {
        hooks.toast(`Stage ranges failed: ${(e as Error).message}`, 'error');
      } finally {
        setBusy(false);
      }
    })();
  });

  // Keep badges truthful while agents and shells edit behind our back.
  setInterval(() => {
    if (!document.hidden && host.isConnected && !host.classList.contains('hidden') && !busy) void refresh();
  }, 15000);

  return {
    refresh,
    focusCommit: () => {
      msgInput.focus();
    },
    hasRepo: () => !!info?.isRepo,
  };
}

export type ScmApi = ReturnType<typeof initScm>;
