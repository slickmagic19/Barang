// Lazy file tree: one depth level per expansion, dirs-first, skips junk by default.
// VSCode-style right-click menus: new/rename/delete/copy path per entry.
import { fsApi, type FsEntry } from '../lib/api';
import { el, copyText } from '../lib/util';
import { iconEl, fileTone } from './icons';
import { showContextMenu } from './menu';

export interface ExplorerHooks {
  onOpenFile(path: string, opts?: { focus?: boolean }): void;
  onPathRenamed(oldPath: string, newPath: string): void;
  onPathRemoved(path: string): void;
  onOpenFolder(): void;
  onCollapseSidebar(): void;
  toast(msg: string, kind?: 'info' | 'error'): void;
}

const expanded = new Set<string>(['.']);
const cache = new Map<string, FsEntry[]>();
let rootName = '';
let treeCtx: { body: HTMLElement; hooks: ExplorerHooks } | null = null;
// VSCode-style selection: toolbar New File/Folder targets the focused entry
// (inside a focused folder, beside a focused file), not always the root.
let focusedEntry: { path: string; type: 'file' | 'dir' } | null = null;

/** Drop focus if it points at a removed path (stale focus mis-targets creates). */
export function clearFocusedEntry(prefix: string) {
  if (focusedEntry && (focusedEntry.path === prefix || focusedEntry.path.startsWith(prefix + '/'))) {
    focusedEntry = null;
  }
}

/** Delete the focused entry (Delete/Backspace key). False when inapplicable
 *  or the user cancels — the shared confirm dialog is the only UI. */
export function deleteFocusedEntry(): boolean {
  const hooks = treeCtx?.hooks;
  if (!treeCtx || !focusedEntry || !hooks) return false;
  const target = { ...focusedEntry };
  if (!confirm(`Delete ${target.path}?${target.type === 'dir' ? ' This removes the folder and everything inside it.' : ''}`)) {
    return false;
  }
  hooks.onPathRemoved(target.path);
  return true;
}

async function childrenOf(path: string): Promise<FsEntry[]> {
  if (!cache.has(path)) {
    const res = await fsApi.tree(path);
    cache.set(path, res.children);
  }
  return cache.get(path)!;
}

export function refreshExplorer() {
  cache.clear();
}

/** Drop expansion + cache (project switch re-inits from scratch). */
export function resetExplorerState() {
  cache.clear();
  expanded.clear();
  expanded.add('.');
}

/** Expand ancestors, repaint, and flash-highlight a path (reveal in tree). */
export async function revealInTree(path: string) {
  if (!treeCtx) return;
  const parts = path.split('/');
  let acc = '';
  for (const part of parts.slice(0, -1)) {
    acc = acc ? `${acc}/${part}` : part;
    expanded.add(acc);
  }
  refreshExplorer();
  await paint(treeCtx.body, treeCtx.hooks);
  try {
    const label = treeCtx.body.querySelector(`.tree-label[title="${CSS.escape(path)}"]`);
    if (label) {
      label.scrollIntoView({ block: 'nearest' });
      label.classList.add('flash');
      setTimeout(() => label.classList.remove('flash'), 1600);
    }
  } catch { /* bad selector — skip highlight */ }
}

function rowIcon(e: FsEntry): HTMLElement {
  if (e.type === 'dir') {
    const open = expanded.has(e.path);
    return iconEl(open ? 'folderOpen' : 'folder', 15);
  }
  const s = iconEl('file', 15);
  s.classList.add(fileTone(e.name));
  return s;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i) || '.';
}

/** Join a typed name onto a directory (VSCode allows `a/b.ts` nesting and
 *  `..` segments in the input); always stays project-relative or fails. */
export function joinNorm(dir: string, name: string): string {
  const parts: string[] = [];
  for (const seg of (dir === '.' ? name : `${dir}/${name}`).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** VSCode-style name validation: illegal chars, trailing dot/space,
 *  duplicates (case-insensitive, Windows-safe). Null = OK.
 *  Always lists FRESH (the render cache may lag external changes). */
export function nameValidator(dir: string, exclude?: string) {
  return async (v: string): Promise<string | null> => {
    if (/[<>:"|?*\x00-\x1f]/.test(v)) return 'Characters < > : " | ? * are not allowed in names.';
    if (/[. ]$/.test(v)) return 'Names cannot end with a dot or space.';
    try {
      const res = await fsApi.tree(dir);
      const kids = res.children ?? [];
      const first = v.split('/')[0].toLowerCase();
      const ex = (exclude ?? '').toLowerCase();
      if (kids.some((k) => k.name.toLowerCase() === first && k.name.toLowerCase() !== ex)) {
        return `A file or folder named "${v.split('/')[0]}" already exists.`;
      }
    } catch {
      /* backend is the source of truth when listing fails */
    }
    return null;
  };
}

/** Always repaint from the ROOT body: painting a sub-container nests the
 *  whole tree inside itself (the classic Barang nesting bug). */
function repaintRoot(): Promise<void> {
  if (treeCtx) return paint(treeCtx.body, treeCtx.hooks).then(() => undefined);
  return Promise.resolve();
}

function findRow(root: HTMLElement, entryPath: string): { row: HTMLElement; label: HTMLButtonElement } | null {
  try {
    const label = root.querySelector(`.tree-label[title="${CSS.escape(entryPath)}"]`) as HTMLButtonElement | null;
    const row = label?.closest('.tree-row') as HTMLElement | null;
    if (!label || !row) return null;
    return { row, label };
  } catch {
    return null;
  }
}

function labelPad(label: HTMLElement): number {
  const v = parseInt(label.style.paddingLeft || '6', 10);
  return Number.isFinite(v) ? v : 6;
}

/** Directory targeted by toolbar creation: inside the focused folder, beside
 *  a focused file, or the root when nothing is focused (VSCode semantics). */
export function focusedTargetDir(): string {
  if (!focusedEntry) return '.';
  return focusedEntry.type === 'dir' ? focusedEntry.path : dirOf(focusedEntry.path);
}

/** Create flow shared by toolbar, blank-area menu, and context menu:
 *  expands the target dir, then prompts in place as its first child. */
export async function promptCreateIn(hooks: ExplorerHooks, dirPath: string, dir: boolean) {
  expanded.add(dirPath);
  refreshExplorer();
  const body = treeCtx?.body;
  if (!body) return;
  await paint(body, hooks);
  const found = findRow(body, dirPath);
  const sub = found?.row.nextElementSibling;
  const hasSub = !!sub && sub.classList.contains('tree-sub');
  const place = hasSub && sub && found
    ? { parent: sub as HTMLElement, before: sub.firstChild, padLeft: labelPad(found.label) + 12 }
    : undefined; // fallback: top of tree
  const label = dir ? 'folder' : 'file';
  // VSCode parity: a bare input holding just the name; the focused row +
  // prompt position imply the location. No placeholder, no buttons.
  await settlePrompt(
    () => inlinePrompt(body, '', (v) => submitCreateIn(hooks, dirPath, v, dir), place,
      (v) => nameValidator(dirPath)(v)),
    () => hooks.toast(`Could not open the new-${label} input. Try again.`, 'error'),
  );
}

async function submitCreateIn(hooks: ExplorerHooks, dir: string, name: string, isDir: boolean) {
  const full = joinNorm(dir, name);
  const what = isDir ? 'folder' : 'file';
  hooks.toast(`Creating ${full}…`, 'info');
  try {
    if (isDir) {
      await fsApi.mkdir(full);
      refreshExplorer();
      expanded.add(full);
    } else {
      await fsApi.write(full, '');
      refreshExplorer();
    }
      await repaintRoot();
      hooks.toast(`Created ${full}.`, 'info');
      // Focus the new entry so chained creates nest like VSCode.
      focusedEntry = { path: full, type: isDir ? 'dir' : 'file' };
      if (!isDir) hooks.onOpenFile(full);
  } catch (e) {
    hooks.toast(`Cannot create ${what}: ${(e as Error).message}`, 'error');
  }
}

async function submitRename(hooks: ExplorerHooks, entry: FsEntry, name: string) {
  const to = joinNorm(dirOf(entry.path), name);
  if (to.toLowerCase() === entry.path.toLowerCase()) return; // unchanged
  const from = entry.path;
  const isDir = entry.type === 'dir';
  hooks.toast(`Renaming to ${to}…`, 'info');
  try {
    const res = await fsApi.rename(from, to);
    refreshExplorer();
    if (isDir) {
      // Move expansion state along with the folder.
      for (const k of [...expanded]) {
        if (k === from || k.startsWith(from + '/')) {
          expanded.delete(k);
          expanded.add(res.path + k.slice(from.length));
        }
      }
    }
    await repaintRoot();
    hooks.toast(`Renamed to ${res.path}.`, 'info');
    focusedEntry = { path: res.path, type: entry.type };
    hooks.onPathRenamed(from, res.path);
  } catch (err) {
    hooks.toast(`Cannot rename: ${(err as Error).message}`, 'error');
  }
}

function entryMenu(e: FsEntry, host: HTMLElement, hooks: ExplorerHooks, x: number, y: number) {
  const isDir = e.type === 'dir';
  showContextMenu(x, y, [
    ...(isDir
      ? []
      : [{ label: 'Open', icon: 'file' as const, run: () => hooks.onOpenFile(e.path, { focus: true }) }]),
    { label: 'New File Here', icon: 'filePlus', run: () => void newHere(e, false) },
    { label: 'New Folder Here', icon: 'folderPlus', run: () => void newHere(e, true) },
    { sep: true },
    { label: 'Rename', icon: 'prompt', run: () => renameHere(e) },
    {
      label: `Delete`, icon: 'trash', danger: true,
      run: () => {
        if (!confirm(`Delete ${e.path}?${isDir ? ' This removes the folder and everything inside it.' : ''}`)) return;
        hooks.onPathRemoved(e.path);
      },
    },
    { sep: true },
    {
      label: 'Copy Path', icon: 'file',
      run: () => void copyText(e.path).then((ok) => hooks.toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')),
    },
  ]);

  // VSCode-style in-place flows: the prompt appears where the action is —
  // replacing the renamed row, or as the first child of the target folder.
  async function newHere(entry: FsEntry, dir: boolean) {
    await promptCreateIn(hooks, entry.type === 'dir' ? entry.path : dirOf(entry.path), dir);
  }

  async function renameHere(entry: FsEntry) {
    const body = treeCtx?.body ?? host;
    const found = findRow(body, entry.path);
    const submit = (v: string) => submitRename(hooks, entry, v);
    const validate = (v: string) => nameValidator(dirOf(entry.path), entry.name)(v);
    if (!found) {
      // Row not currently rendered (filtered/collapsed) — fall back to top.
      await settlePrompt(
        () => inlinePrompt(body, entry.name, submit, undefined, validate),
        () => hooks.toast('Could not open the rename input. Try again.', 'error'),
      );
      return;
    }
    await settlePrompt(
      () => inlinePrompt(body, entry.name, submit, {
        parent: found.row.parentElement ?? body,
        before: found.row.nextSibling,
        hideRow: found.row,
        padLeft: labelPad(found.label),
      }, validate),
      () => hooks.toast('Could not open the rename input. Try again.', 'error'),
    );
  }

}

async function renderTree(host: HTMLElement, hooks: ExplorerHooks, path: string, depth: number, my: number): Promise<boolean> {
  let kids: FsEntry[];
  try {
    kids = await childrenOf(path);
  } catch (e) {
    if (my !== paintSeq) return false;
    host.append(el('div', { class: 'tree-err' }, `Failed to list ${path}: ${(e as Error).message}`));
    return true;
  }
  if (my !== paintSeq) return false; // superseded mid-fetch — never touch the DOM
  for (const e of kids) {
    const row = el('div', { class: 'tree-row' });
    const isDir = e.type === 'dir';
    const open = isDir && expanded.has(e.path);
    const label = el('button', {
      class: `tree-label${open ? ' open' : ''}${focusedEntry && focusedEntry.path === e.path ? ' focused' : ''}`,
      title: e.path,
      style: `padding-left:${6 + depth * 12}px`,
    }) as HTMLButtonElement;
    if (isDir) {
      const tw = el('span', { class: 'tw' });
      tw.append(iconEl('chevR', 12));
      label.append(tw);
    }
    const glyph = rowIcon(e);
    if (isDir) glyph.classList.add('ft-folder');
    label.append(glyph, el('span', { class: 'tree-name' }, e.name));
    row.append(label);
    host.append(row);
    label.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      entryMenu(e, host, hooks, ev.clientX, ev.clientY);
    };
    if (isDir) {
      // Re-expand from the ROOT body: repainting into the local sub-div
      // would nest the whole tree inside itself on every click.
      label.onclick = () => {
        focusedEntry = { path: e.path, type: 'dir' };
        if (expanded.has(e.path)) expanded.delete(e.path);
        else expanded.add(e.path);
        if (treeCtx) void paint(treeCtx.body, treeCtx.hooks);
      };
      if (open) {
        const sub = el('div', { class: 'tree-sub' });
        host.append(sub);
        const ok = await renderTree(sub, hooks, e.path, depth + 1, my);
        if (!ok) return false;
      }
    } else {
      label.onclick = () => {
        focusedEntry = { path: e.path, type: 'file' };
        // Query the LIVE tree: this closure's host may be a superseded
        // staging container after an atomic swap.
        const live = treeCtx?.body ?? host;
        live.querySelectorAll('.tree-label.active').forEach((n) => n.classList.remove('active'));
        label.classList.add('active');
        // VSCode parity: single click selects + opens WITHOUT stealing
        // focus, so Delete and other tree keys keep working. Double-click
        // (or Enter) moves into the editor.
        hooks.onOpenFile(e.path, { focus: false });
      };
      label.ondblclick = () => {
        hooks.onOpenFile(e.path, { focus: true });
      };
    }
  }
  return true;
}

let paintSeq = 0;

function renderSkeletons(host: HTMLElement, n = 12) {
  host.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const r = el('div', { class: 'skel-row' });
    // Stagger widths/indents for a tree-like shimmer.
    const w = 42 + ((i * 37) % 44);
    const pad = (i % 4) * 10;
    r.append(el('span', { class: 'skel-ic' }), el('span', { class: 'skel-bar', style: `width:${w}%;margin-left:${pad}px` }));
    host.append(r);
  }
}

async function paint(host: HTMLElement, hooks: ExplorerHooks) {
  // Never nuke an inline prompt the user is actively typing in — the next
  // refresh trigger will repaint once it is submitted or dismissed.
  if (host.querySelector('.tree-prompt-input:focus')) return;
  if (!document.contains(host)) return; // detached by a project switch
  const my = ++paintSeq;
  // First paint shows skeletons instantly; refreshes render off-DOM and swap
  // atomically — no clear-then-fill flash, no interleaved rows, ever.
  if (!host.querySelector('.tree-row, .tree-err')) renderSkeletons(host);
  const staging = document.createElement('div');
  const ok = await renderTree(staging, hooks, '.', 0, my);
  if (!ok || my !== paintSeq || !document.contains(host)) return;
  host.replaceChildren(...staging.childNodes);
}

/** Where the inline prompt lives. Default (omitted) = pinned to the top,
 *  like the toolbar flows. Rename replaces the row; new-here nests inside. */
export interface PromptPlace {
  parent: HTMLElement;
  before: Node | null;
  hideRow?: HTMLElement | null;
  padLeft?: number;
}

function inlinePrompt(
  host: HTMLElement,
  initial: string,
  onSubmit: (v: string) => void,
  place?: PromptPlace,
  validate?: (v: string) => Promise<string | null>,
) {
  const wrap = el('div', { class: 'tree-prompt' });
  const input = el('input', {
    class: 'tree-prompt-input',
    spellcheck: 'false',
    'aria-label': 'File or folder name',
  }) as HTMLInputElement;
  input.value = initial;
  const showError = (msg: string | null) => {
    wrap.classList.toggle('has-error', !!msg);
    let err = wrap.querySelector('.tree-prompt-error');
    if (!msg) {
      err?.remove();
      return;
    }
    if (!err) {
      err = el('div', { class: 'tree-prompt-error' });
      wrap.append(err);
    }
    err.textContent = msg;
  };
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    if (validate) {
      let err: string | null = null;
      try {
        err = await validate(v);
      } catch {
        err = null; // validation is advisory; the backend decides
      }
      if (err) {
        showError(err);
        return;
      }
    }
    showError(null);
    cleanup();
    onSubmit(v);
  };
  // Enter commits, Escape cancels — the only two gestures, like VSCode.
  // (No confirm button: it fought the blur-to-dismiss it was meant to help.)
  const cleanup = () => {
    // Restore a hidden rename row (no-op if a repaint already replaced it).
    try {
      if (place?.hideRow && place.hideRow.style.display === 'none') {
        place.hideRow.style.display = '';
      }
    } catch { /* detached — nothing to restore */ }
    wrap.remove();
  };
  const row = el('div', { class: 'tree-prompt-row' });
  row.append(input);
  wrap.append(row);
  const target = place ?? { parent: host, before: host.firstChild };
  if (target.hideRow) target.hideRow.style.display = 'none';
  target.parent.insertBefore(wrap, target.before);
  if (target.padLeft !== undefined) wrap.style.paddingLeft = `${target.padLeft}px`;
  wrap.scrollIntoView({ block: 'nearest' });
  const focusInput = () => {
    input.focus({ preventScroll: true });
    try {
      // VSCode-style: select the basename without extension (rename) or park
      // the caret at the end (fresh path with trailing dir prefix).
      const baseStart = initial.lastIndexOf('/') + 1;
      let selEnd = initial.length;
      const dot = initial.lastIndexOf('.');
      if (dot > baseStart) selEnd = dot;
      input.setSelectionRange(baseStart, selEnd);
    } catch { /* non-text input types — ignore */ }
  };
  focusInput();
  // Re-assert focus on the next frame: the opening click's mouseup/focus
  // restoration can otherwise land focus back on the toolbar button.
  requestAnimationFrame(() => {
    if (document.contains(input) && document.activeElement !== input) focusInput();
  });
  // Belt and suspenders: while focus NEVER entered the input, keep pulling
  // it in for a few seconds (covers environments where the initial focus
  // silently fails). Once the user has focused (or dismissed), stop — never
  // fight deliberate navigation away, which must still dismiss via blur.
  let everFocused = document.activeElement === input;
  const focusStart = Date.now();
  const focusTimer = setInterval(() => {
    if (!document.contains(input)) {
      clearInterval(focusTimer);
      return;
    }
    if (!everFocused && document.activeElement !== input && !wrap.contains(document.activeElement)) {
      focusInput();
    }
    if (everFocused || Date.now() - focusStart > 3000) clearInterval(focusTimer);
  }, 250);
  // Clicking anywhere on the prompt row focuses the input (covers cases
  // where the programmatic focus above never landed).
  wrap.onmousedown = () => {
    requestAnimationFrame(() => {
      if (document.contains(input) && document.activeElement !== input) focusInput();
    });
  };
  // Last resort, and a built-in diagnostic: if focus still hasn't arrived
  // after everything settles, pulse the box so the user clicks into it —
  // and a screenshot of the pulse proves an environment focus failure.
  setTimeout(() => {
    if (document.contains(input) && document.activeElement !== input && !wrap.contains(document.activeElement)) {
      wrap.classList.add('needs-focus');
    }
  }, 350);
  input.onfocus = () => {
    everFocused = true;
    wrap.classList.remove('needs-focus');
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void submit();
    else if (e.key === 'Escape') cleanup();
  };
  // Typing clears a previous validation error (VSCode behavior).
  input.oninput = () => showError(null);
  // Dismiss only when focus truly leaves the prompt (tabbing between the
  // input and the confirm button must not destroy it).
  input.onblur = (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && wrap.contains(to)) return;
    // Give the confirm mousedown (preventDefaulted, no blur) a beat first.
    setTimeout(() => {
      if (document.activeElement !== input && !wrap.contains(document.activeElement)) cleanup();
    }, 150);
  };
  return wrap;
}

/**
 * Open a prompt and verify it survived focus settlement. Opening from a
 * context menu races Chromium's focus fixup for the removed menu node: the
 * fresh prompt can lose focus and self-dismiss within milliseconds. On
 * failure the prompt is re-opened once; if it still won't stick, onFail
 * fires (visible error — never a silent nothing).
 */
async function settlePrompt(open: () => HTMLElement, onFail: () => void): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const wrap = open();
      // Let focus fixup + one repaint cycle settle, then check attachment.
      await new Promise((r) => setTimeout(r, 200));
      if (document.contains(wrap) && wrap.querySelector('.tree-prompt-input')) return;
    } catch {
      /* retry once below */
    }
  }
  onFail();
}

export function initExplorer(sidebar: HTMLElement, hooks: ExplorerHooks, projectRoot: string) {
  rootName = projectRoot.split(/[\\/]/).filter(Boolean).pop() || '';
  // Welcome state: no project open yet — offer entry points, not an error.
  if (!projectRoot) {
    const empty = el('div', { class: 'tree-empty' });
    const glyph = iconEl('folderOpen', 30);
    empty.append(
      glyph,
      el('div', { class: 'tree-empty-title' }, 'No folder open'),
      el('div', { class: 'tree-empty-sub' }, 'Open a project to browse files and start the agent.'),
    );
    const btn = el('button', { class: 'btn btn-primary btn-sm' }, 'Open folder');
    btn.onclick = () => hooks.onOpenFolder();
    empty.append(btn);
    sidebar.append(empty);
    treeCtx = null;
    return { repaint: () => {} };
  }
  const header = el('div', { class: 'side-header' });
  const title = el('span', { class: 'side-title' }, rootName);
  const actions = el('div', { class: 'side-actions' });
  const btnNewFile = el('button', { class: 'icon-btn', title: 'New file' }) as HTMLButtonElement;
  btnNewFile.append(iconEl('filePlus', 15));
  const btnNewDir = el('button', { class: 'icon-btn', title: 'New folder' }) as HTMLButtonElement;
  btnNewDir.append(iconEl('folderPlus', 15));
  const btnRefresh = el('button', { class: 'icon-btn', title: 'Refresh' }) as HTMLButtonElement;
  btnRefresh.append(iconEl('refresh', 14));
  const btnCollapse = el('button', { class: 'icon-btn side-collapse', title: 'Hide explorer (Ctrl+B)' }) as HTMLButtonElement;
  btnCollapse.append(iconEl('chevL', 14));
  btnCollapse.onclick = () => hooks.onCollapseSidebar();
  actions.append(btnNewFile, btnNewDir, btnRefresh, btnCollapse);
  header.append(title, actions);
  const body = el('div', { class: 'tree' });
  sidebar.append(header, body);
  treeCtx = { body, hooks };
  body.oncontextmenu = (e) => {
    // Blank-area menu: create at root.
    if ((e.target as HTMLElement).closest('.tree-label')) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'New File', icon: 'filePlus', run: () => void promptCreateIn(hooks, '.', false) },
      { label: 'New Folder', icon: 'folderPlus', run: () => void promptCreateIn(hooks, '.', true) },
      { label: 'Refresh', icon: 'refresh', run: () => { refreshExplorer(); void paint(body, hooks); } },
    ]);
  };

  btnRefresh.onclick = () => {
    refreshExplorer();
    void paint(body, hooks);
  };
  btnNewFile.onclick = () => void promptCreateIn(hooks, focusedTargetDir(), false);
  btnNewDir.onclick = () => void promptCreateIn(hooks, focusedTargetDir(), true);

  void paint(body, hooks);
  return { repaint: () => paint(body, hooks) };
}
