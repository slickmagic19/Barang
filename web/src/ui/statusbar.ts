// Bottom status bar: project, opencode link state, session state, cursor.
import { agentStore, readSettings, sessionUsage, usageCard } from '../lib/agent';
import { pomoStore, formatClock } from '../lib/pomodoro';
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

export function initStatusbar(bar: HTMLElement, info: StatusInfo, hooks: { onToggleTerminal?: () => void; onOpenScm?: (x: number, y: number) => void; onOpenPomo?: () => void } = {}) {
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
  const pomoEl = el('button', { class: 'status-item status-pomo hidden', title: 'Open Pomodoro' }) as HTMLButtonElement;
  const pomoLabel = el('span', {}, '');
  pomoEl.append(iconEl('timer', 12), pomoLabel);
  pomoEl.onclick = () => hooks.onOpenPomo?.();
  const usageEl = el('span', { class: 'status-item status-usage hidden' });
  const usageLabel = el('span', {}, '');
  usageEl.append(iconEl('spark', 12), usageLabel);
  // Rich hover card (Cost / Usage / Tokens + breakdown). Pointer-events
  // none so moving the mouse never flickers it; rebuilt on every hover.
  const usageCardEl = el('div', { class: 'usage-card' });
  document.body.append(usageCardEl);
  const hideUsageCard = () => usageCardEl.classList.remove('visible');
  usageEl.addEventListener('mouseenter', () => {
    const st = agentStore.get();
    const sess = st.sessions.find((s) => s.id === st.activeId) ?? null;
    const modelLabel = st.model ? `${st.model.providerID}/${st.model.modelID}` : 'auto model';
    const limit = st.model
      ? (st.providerModels.find((m) => m.providerID === st.model!.providerID && m.modelID === st.model!.modelID)?.limit ?? null)
      : null;
    const card = usageCard(sess, modelLabel, st.messages.length, limit);
    if (!card) {
      hideUsageCard();
      return;
    }
    usageCardEl.innerHTML = '';
    const head = el('div', { class: 'usage-head' });
    head.append(el('div', { class: 'usage-title' }, card.title), el('div', { class: 'usage-model' }, card.model));
    usageCardEl.append(head);
    const hero = (label: string, value: string, bar?: number | null) => {
      const row = el('div', { class: 'usage-row usage-hero' });
      row.append(el('span', { class: 'usage-label' }, label), el('span', { class: 'usage-value' }, value));
      if (typeof bar === 'number') {
        const track = el('div', { class: 'usage-bar' });
        const fill = el('div', { class: 'usage-fill' });
        fill.style.width = `${Math.min(100, Math.max(0, bar))}%`;
        track.append(fill);
        const wrap = el('div', {});
        wrap.append(row, track);
        return wrap;
      }
      return row;
    };
    usageCardEl.append(hero('Cost', card.cost));
    usageCardEl.append(hero('Usage', card.pct === null ? '—' : `${card.pct}%`, card.pct));
    usageCardEl.append(hero('Tokens', card.tokens));
    const sep = el('div', { class: 'usage-sep' });
    usageCardEl.append(sep);
    const kv = (label: string, value: string) => {
      const row = el('div', { class: 'usage-row' });
      row.append(el('span', { class: 'usage-label' }, label), el('span', { class: 'usage-value usage-dim' }, value));
      return row;
    };
    usageCardEl.append(kv('Input', card.input));
    usageCardEl.append(kv('Output', card.output));
    usageCardEl.append(kv('Reasoning', card.reasoning));
    usageCardEl.append(kv('Cache R/W', card.cache));
    usageCardEl.append(kv('Messages', String(card.messages)));
    usageCardEl.append(kv('Context limit', card.limit === null ? 'unknown' : card.limit.toLocaleString('en-US')));
    usageCardEl.append(kv('Updated', card.updated));
    // Anchor above the meter, right-aligned to it; clamp to viewport.
    const r = usageEl.getBoundingClientRect();
    usageCardEl.classList.add('visible');
    const cw = usageCardEl.offsetWidth;
    const ch = usageCardEl.offsetHeight;
    usageCardEl.style.left = `${Math.max(8, Math.min(window.innerWidth - cw - 8, r.right - cw))}px`;
    usageCardEl.style.top = `${Math.max(8, r.top - ch - 10)}px`;
  });
  usageEl.addEventListener('mouseleave', hideUsageCard);
  const dirtyEl = el('span', { class: 'status-item' });
  const posEl = el('span', { class: 'status-item' }, 'Ln 1, Col 1');
  left.append(rootEl, gitEl, ocEl);
    right.append(termEl, sessEl, modelEl, usageEl, pomoEl, dirtyEl, posEl);
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
      // No native title: the custom hover card owns the tooltip.
      usageEl.removeAttribute('title');
    } else {
      hideUsageCard();
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

    // Pomodoro readout (own store tick): hidden until a session starts.
    const pomo = pomoStore.get();
    const pomoLive = pomo.status !== 'idle';
    pomoEl.classList.toggle('hidden', !pomoLive);
    if (pomoLive) {
      pomoLabel.textContent = formatClock(pomo.remainingMs);
      pomoEl.title = pomo.status === 'paused'
        ? `Pomodoro paused — ${pomo.phase} (click to open)`
        : `Pomodoro ${pomo.phase} — ${formatClock(pomo.remainingMs)} left (click to open)`;
      pomoEl.classList.toggle('is-run', pomo.status === 'running');
    }

    const active = e.tabs.find((t) => t.path === e.active);
    posEl.textContent = active ? `${active.title ?? active.path.split('/').pop()} · ${posEl.dataset.pos || 'Ln 1, Col 1'}` : 'no file';
  };
  agentStore.subscribe(paint);
  editorStore.subscribe(paint);
  pomoStore.subscribe(paint);
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
