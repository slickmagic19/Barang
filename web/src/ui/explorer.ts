// Lazy file tree: one depth level per expansion, dirs-first, skips junk by default.
// VSCode-style right-click menus: new/rename/delete/copy path per entry.
import { fsApi, type FsEntry } from '../lib/api';
import { el, copyText } from '../lib/util';
import { iconEl, fileTone } from './icons';
import { showContextMenu } from './menu';

export interface ExplorerHooks {
  onOpenFile(path: string): void;
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

function entryMenu(e: FsEntry, host: HTMLElement, hooks: ExplorerHooks, x: number, y: number) {
  const isDir = e.type === 'dir';
  const base = isDir ? e.path : dirOf(e.path);
  showContextMenu(x, y, [
    ...(isDir
      ? []
      : [{ label: 'Open', icon: 'file' as const, run: () => hooks.onOpenFile(e.path) }]),
    { label: 'New File Here', icon: 'filePlus', run: () => inlinePrompt(host, `${base === '.' ? '' : base + '/'}new-file.ts`, `${base === '.' ? '' : base + '/'}`, submitCreateFile) },
    { label: 'New Folder Here', icon: 'folderPlus', run: () => inlinePrompt(host, `${base === '.' ? '' : base + '/'}new-folder`, `${base === '.' ? '' : base + '/'}`, submitCreateDir) },
    { sep: true },
    { label: 'Rename', icon: 'prompt', run: () => inlinePrompt(host, `Rename ${e.name} to…`, e.path, (v) => submitRename(e.path, v)) },
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

  async function submitCreateFile(v: string) {
    hooks.toast(`Creating ${v}…`, 'info');
    try {
      const res = await fsApi.write(v, '');
      refreshExplorer();
      await paint(host, hooks);
      hooks.toast(`Created ${res.path}.`, 'info');
      hooks.onOpenFile(v);
    } catch (e) {
      hooks.toast(`Cannot create file: ${(e as Error).message}`, 'error');
    }
  }
  async function submitCreateDir(v: string) {
    hooks.toast(`Creating folder ${v}…`, 'info');
    try {
      await fsApi.mkdir(v);
      refreshExplorer();
      expanded.add(v);
      await paint(host, hooks);
      hooks.toast(`Created folder ${v}.`, 'info');
    } catch (e) {
      hooks.toast(`Cannot create folder: ${(e as Error).message}`, 'error');
    }
  }
  async function submitRename(from: string, to: string) {
    if (!to || to === from) return;
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
      await paint(host, hooks);
      hooks.toast(`Renamed to ${res.path}.`, 'info');
      hooks.onPathRenamed(from, res.path);
    } catch (err) {
      hooks.toast(`Cannot rename: ${(err as Error).message}`, 'error');
    }
  }
}

async function renderTree(host: HTMLElement, hooks: ExplorerHooks, path: string, depth: number) {
  let kids: FsEntry[];
  try {
    kids = await childrenOf(path);
  } catch (e) {
    host.append(el('div', { class: 'tree-err' }, `Failed to list ${path}: ${(e as Error).message}`));
    return;
  }
  for (const e of kids) {
    const row = el('div', { class: 'tree-row' });
    const isDir = e.type === 'dir';
    const open = isDir && expanded.has(e.path);
    const label = el('button', {
      class: `tree-label${open ? ' open' : ''}`,
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
        if (expanded.has(e.path)) expanded.delete(e.path);
        else expanded.add(e.path);
        if (treeCtx) void paint(treeCtx.body, treeCtx.hooks);
      };
      if (open) {
        const sub = el('div', { class: 'tree-sub' });
        host.append(sub);
        await renderTree(sub, hooks, e.path, depth + 1);
      }
    } else {
      label.onclick = () => {
        host.querySelectorAll('.tree-label.active').forEach((n) => n.classList.remove('active'));
        label.classList.add('active');
        hooks.onOpenFile(e.path);
      };
    }
  }
}

async function paint(host: HTMLElement, hooks: ExplorerHooks) {
  // Never nuke an inline prompt the user is actively typing in — the next
  // refresh trigger will repaint once it is submitted or dismissed.
  if (host.querySelector('.tree-prompt-input:focus')) return;
  host.innerHTML = '';
  await renderTree(host, hooks, '.', 0);
}

function inlinePrompt(host: HTMLElement, placeholder: string, initial: string, onSubmit: (v: string) => void) {
  const wrap = el('div', { class: 'tree-prompt' });
  const input = el('input', { class: 'tree-prompt-input', placeholder }) as HTMLInputElement;
  input.value = initial;
  const okBtn = el('button', { class: 'tree-prompt-ok', title: 'Confirm (Enter)' }) as HTMLButtonElement;
  okBtn.append(iconEl('check', 13));
  const submit = () => {
    const v = input.value.trim();
    if (!v) return;
    wrap.remove();
    onSubmit(v);
  };
  // mousedown (not click): clicking would blur the input first, and blur
  // dismisses the prompt — preventDefault keeps focus until submit runs.
  okBtn.onmousedown = (e) => {
    e.preventDefault();
    submit();
  };
  wrap.append(input, okBtn);
  host.prepend(wrap);
  input.focus();
  input.setSelectionRange(initial.length, initial.length);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') wrap.remove();
  };
  input.onblur = () => wrap.remove();
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
      { label: 'New File', icon: 'filePlus', run: () => inlinePrompt(body, 'new-file.ts (relative to root)', '', createFileAtRoot) },
      { label: 'New Folder', icon: 'folderPlus', run: () => inlinePrompt(body, 'new-folder (relative to root)', '', createDirAtRoot) },
      { label: 'Refresh', icon: 'refresh', run: () => { refreshExplorer(); void paint(body, hooks); } },
    ]);
  };

  async function createFileAtRoot(v: string) {
    hooks.toast(`Creating ${v}…`, 'info');
    try {
      const res = await fsApi.write(v, '');
      refreshExplorer();
      await paint(body, hooks);
      hooks.toast(`Created ${res.path}.`, 'info');
      hooks.onOpenFile(v);
    } catch (e) {
      hooks.toast(`Cannot create file: ${(e as Error).message}`, 'error');
    }
  }
  async function createDirAtRoot(v: string) {
    hooks.toast(`Creating folder ${v}…`, 'info');
    try {
      await fsApi.mkdir(v);
      refreshExplorer();
      expanded.add(v);
      await paint(body, hooks);
      hooks.toast(`Created folder ${v}.`, 'info');
    } catch (e) {
      hooks.toast(`Cannot create folder: ${(e as Error).message}`, 'error');
    }
  }

  btnRefresh.onclick = () => {
    refreshExplorer();
    void paint(body, hooks);
  };
  btnNewFile.onclick = () => inlinePrompt(body, 'new-file.ts (path relative to root)', '', createFileAtRoot);
  btnNewDir.onclick = () => inlinePrompt(body, 'new-folder (path relative to root)', '', createDirAtRoot);

  void paint(body, hooks);
  return { repaint: () => paint(body, hooks) };
}
