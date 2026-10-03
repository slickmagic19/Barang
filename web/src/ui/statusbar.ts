// Bottom status bar: project, opencode link state, session state, cursor.
import { agentStore, readSettings, sessionUsage } from '../lib/agent';
import { editorStore } from './editor';
import type { GitRepoInfo } from './scm';
import { el } from '../lib/util';
import { iconEl } from './icons';

export interface StatusInfo {
  root: string;
  opencodeVersion: string | null;
  opencodeOk: boolean;
}

function dot(cls: string): HTMLElement {
  const s = el('span', { class: cls });
  s.append(iconEl('dot', 7));
  return s;
}

export function initStatusbar(bar: HTMLElement, info: StatusInfo, hooks: { onToggleTerminal?: () => void; onOpenScm?: (x: number, y: number) => void } = {}) {
  const left = el('div', { class: 'status-left' });
  const right = el('div', { class: 'status-right' });
  bar.append(left, right);

  const rootEl = el('span', { class: 'status-item', title: info.root || 'No folder open' });
  const rootName = el('span', {}, info.root.split(/[\\/]/).pop() || 'No folder open');
  rootEl.append(iconEl('folder', 13), rootName);
  const gitEl = el('button', { class: 'status-item status-git hidden', title: 'Select branch' }) as HTMLButtonElement;
  const gitLabel = el('span', {}, '');
  gitEl.append(iconEl('branch', 12), gitLabel);
  gitEl.onclick = (e) => hooks.onOpenScm?.(e.clientX, e.clientY);
  const ocEl = el('span', { class: 'status-item' });
  const termEl = el('button', { class: 'status-item status-term', title: 'Toggle terminal (Ctrl+`)' }) as HTMLButtonElement;
  const termLabel = el('span', {}, 'Terminal');
  termEl.append(iconEl('prompt', 12), termLabel);
  termEl.onclick = () => hooks.onToggleTerminal?.();
  const sessEl = el('span', { class: 'status-item' });
  const modelEl = el('span', { class: 'status-item' });
  const usageEl = el('span', { class: 'status-item status-usage hidden', title: 'Session usage' });
  const usageLabel = el('span', {}, '');
  usageEl.append(iconEl('spark', 12), usageLabel);
  const dirtyEl = el('span', { class: 'status-item' });
  const posEl = el('span', { class: 'status-item' }, 'Ln 1, Col 1');
  left.append(rootEl, gitEl, ocEl);
  right.append(termEl, sessEl, modelEl, usageEl, dirtyEl, posEl);
  let termCount = 0;
  let termOpen = false;
  let git: GitRepoInfo | null = null;

  const paint = () => {
    const a = agentStore.get();
    const e = editorStore.get();
    termLabel.textContent = termCount > 0 ? `Terminal (${termCount})` : 'Terminal';
    termEl.classList.toggle('is-open', termOpen);
    // Session cost meter (server-side totals, exact at any history size).
    const showUsage = readSettings().showUsage;
    const use = showUsage ? sessionUsage(a.sessions.find((s) => s.id === a.activeId) ?? null) : null;
    usageEl.classList.toggle('hidden', !use);
    if (use) {
      usageLabel.textContent = use.label;
      usageEl.title = use.title;
    }
    // Git branch (VSCode left-side indicator): hidden outside repos.
    gitEl.classList.toggle('hidden', !git);
    if (git) {
      const bits = [git.branch];
      if (git.dirty) bits.push('*');
      if (git.ahead > 0) bits.push(`↑${git.ahead}`);
      if (git.behind > 0) bits.push(`↓${git.behind}`);
      gitLabel.textContent = bits.join(' ');
      gitEl.title = `Git: ${git.branch}${git.tracking ? ` → ${git.tracking}` : ''} — select branch`;
    }
    ocEl.innerHTML = '';
    if (info.opencodeOk) {
      ocEl.append(dot('ok'), el('span', {}, `opencode ${info.opencodeVersion ?? ''}`.trim()));
    } else {
      ocEl.append(dot('bad'), el('span', {}, 'opencode offline'));
    }
    ocEl.classList.toggle('is-busy', a.busy);

    sessEl.innerHTML = '';
    sessEl.classList.toggle('is-warn', a.permissions.length > 0);
    if (a.busy && a.status === 'retry') {
      const n = a.statusInfo?.attempt ?? 0;
      sessEl.append(dot('run'), el('span', {}, n > 0 ? `agent: retrying (attempt ${n})` : 'agent: retrying'));
    } else if (a.busy && a.status === 'stopping') sessEl.append(dot('run'), el('span', {}, 'agent: stopping'));
    else if (a.busy) sessEl.append(dot('run'), el('span', {}, `agent: ${a.status}`));
    else if (a.permissions.length) {
      sessEl.append(iconEl('shield', 12), el('span', {}, `${a.permissions.length} approval${a.permissions.length > 1 ? 's' : ''}`));
    } else sessEl.append(dot('ok'), el('span', {}, 'agent idle'));

    modelEl.innerHTML = '';
    modelEl.append(iconEl('spark', 12), el('span', {}, a.model ? `${a.model.providerID}/${a.model.modelID}` : 'auto model'));

    const dirty = e.tabs.filter((t) => t.dirty).length;
    dirtyEl.innerHTML = '';
    if (dirty) dirtyEl.append(dot('warn'), el('span', {}, `${dirty} unsaved`));

    const active = e.tabs.find((t) => t.path === e.active);
    posEl.textContent = active ? `${active.title ?? active.path.split('/').pop()} · ${posEl.dataset.pos || 'Ln 1, Col 1'}` : 'no file';
  };
  agentStore.subscribe(paint);
  editorStore.subscribe(paint);
  paint();

  return {
    setCursor(line: number, col: number) {
      posEl.dataset.pos = `Ln ${line}, Col ${col}`;
      paint();
    },
    setOpencode(ok: boolean, version: string | null) {
      info.opencodeOk = ok;
      info.opencodeVersion = version;
      paint();
    },
    setRoot(next: string) {
      info.root = next;
      rootEl.title = next || 'No folder open';
      rootName.textContent = next.split(/[\\/]/).pop() || 'No folder open';
      paint();
    },
    setTerminal(count: number, open: boolean) {
      termCount = count;
      termOpen = open;
      paint();
    },
    setGit(next: GitRepoInfo | null) {
      git = next;
      paint();
    },
  };
}
