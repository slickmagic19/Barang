// Integrated terminal: VSCode-style bottom panel over xterm.js + node-pty.
// Multiple terminals, vertical split, find, bell flash, per-tab kill, live
// settings. Instances live in the main process, so hiding the panel (or hot
// project switches) never kills shells — xterm mounts are only views.
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import 'xterm/css/xterm.css';
import { barang } from '../lib/transport';
import { readSettings } from '../lib/agent';
import { el } from '../lib/util';
import { iconEl, type IconName } from './icons';
import { showContextMenu } from './menu';

export interface TerminalHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
}

interface TermRec {
  id: string;
  shell: string;
  cwd: string;
  col: 0 | 1;
  dead: boolean;
  exitCode: number | null;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  mount: HTMLElement;
  tab: HTMLButtonElement;
  bellTimer?: ReturnType<typeof setTimeout>;
}

const MAX_TERMS = 12;
const LS_OPEN = 'barang:term-open';
const LS_H = 'barang:term-h';

const TERM_THEME = {
  background: '#0a0a0c',
  foreground: '#d6d6d6',
  cursor: '#e8e8e8',
  cursorAccent: '#0a0a0c',
  selectionBackground: '#ffffff38',
  black: '#0a0a0c', red: '#f14c4c', green: '#23d18b', yellow: '#e5e510',
  blue: '#3b8eea', magenta: '#bc3fbc', cyan: '#29b8db', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

function shellBase(shell: string): string {
  return (shell.split(/[\\/]/).pop() || 'shell').replace(/\.exe$/i, '');
}

export function applyTerminalPrefs(): void {
  // Live-apply font/scrollback/blink to every open terminal (shells keep running).
  for (const t of terms) {
    try {
      t.term.options.fontSize = prefs().fontSize;
      t.term.options.scrollback = prefs().scrollback;
      t.term.options.cursorBlink = prefs().blink;
      t.fit.fit();
      void reportSize(t);
    } catch {
      /* closing terminal */
    }
  }
}

function prefs() {
  const s = readSettings();
  return {
    fontSize: s.termFont,
    scrollback: s.termScrollback,
    blink: s.termBlink,
    shell: s.termShell.trim(),
  };
}

// Module state (single panel per window).
let terms: TermRec[] = [];
let activeId: string | null = null;
let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let colEls: HTMLElement[] = [];
let findEl: HTMLElement | null = null;
let findInput: HTMLInputElement | null = null;
let findCount: HTMLElement | null = null;
let hooksRef: TerminalHooks = { toast: () => undefined };
let onChangeCb: (info: { count: number; open: boolean }) => void = () => undefined;
let focusedCount = 0; // >0 while any xterm holds DOM focus
let fitTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  onChangeCb({ count: terms.length, open: isOpen() });
}

function active(): TermRec | undefined {
  return terms.find((t) => t.id === activeId);
}

async function reportSize(t: TermRec): Promise<void> {
  const d = t.fit.proposeDimensions();
  if (d && d.cols >= 2 && d.rows >= 1) {
    try {
      await barang().term.resize(t.id, d.cols, d.rows);
    } catch {
      /* terminal closed mid-fit */
    }
  }
}

function scheduleFit(): void {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    for (const t of terms) {
      try {
        t.fit.fit();
        void reportSize(t);
      } catch {
        /* hidden/closing */
      }
    }
  }, 120);
}

function paintTabs(): void {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  for (const t of terms) {
    const b = el('button', {
      class: `term-tab${t.id === activeId ? ' active' : ''}${t.dead ? ' is-dead' : ''}`,
      title: t.dead
        ? `${t.shell} — exited (${t.exitCode ?? '?'}) · double-click to relaunch`
        : `${t.shell}\n${t.cwd}`,
      'data-term-id': t.id,
    }) as HTMLButtonElement;
    b.append(el('span', { class: 'term-tab-name' }, `${shellBase(t.shell)}${t.col === 1 ? ' ›' : ''}`));
    if (t.dead) b.append(el('span', { class: 'term-exit' }, `${t.exitCode ?? '?'}`));
    const x = el('span', { class: 'term-tab-x', title: t.dead ? 'Remove' : 'Kill terminal' });
    x.append(iconEl('x', 11));
    x.onclick = (e) => {
      e.stopPropagation();
      void killTerm(t.id, true);
    };
    b.append(x);
    b.onclick = () => activate(t.id, true);
    b.ondblclick = () => {
      if (t.dead) void relaunch(t);
    };
    t.tab = b;
    tabsEl.append(b);
  }
  const anyCol1 = terms.some((t) => t.col === 1);
  colEls[1]?.classList.toggle('hidden', !anyCol1);
  emptyEl?.classList.toggle('hidden', terms.length > 0);
  emit();
}

function activate(id: string, focus: boolean): void {
  activeId = id;
  paintTabs();
  if (focus) terms.find((t) => t.id === id)?.term.focus();
}

async function killTerm(id: string, userInitiated: boolean): Promise<void> {
  const t = terms.find((x) => x.id === id);
  try {
    await barang().term.kill(id);
  } catch {
    /* already gone */
  }
  if (userInitiated || !t) {
    // User kill (or unknown): drop the view immediately (VSCode trash).
    disposeTerm(id);
  }
  // External exit (typed `exit`): the term:exit event marks the tab dead.
}

function disposeTerm(id: string): void {
  const i = terms.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = terms.splice(i, 1);
  try {
    t.search.dispose();
    t.fit.dispose();
    t.term.dispose();
  } catch {
    /* noop */
  }
  t.mount.remove();
  if (activeId === id) activeId = terms[terms.length - 1]?.id ?? null;
  paintTabs();
}

async function relaunch(t: TermRec): Promise<void> {
  const col = t.col;
  disposeTerm(t.id);
  await newTerminal({ col, focus: true });
}

async function newTerminal(opts: { col?: 0 | 1; focus?: boolean } = {}): Promise<void> {
  if (terms.length >= MAX_TERMS) {
    hooksRef.toast(`Terminal limit reached (${MAX_TERMS}). Kill one first.`, 'info');
    return;
  }
  const p = prefs();
  const a = active();
  const col = opts.col ?? (a && a.col === 0 ? 1 : 0);
  let info;
  try {
    info = await barang().term.create({ shell: p.shell || undefined, cols: 80, rows: 24 });
  } catch (e) {
    hooksRef.toast(`Terminal failed: ${(e as Error).message}`, 'error');
    return;
  }
  const term = new Terminal({
    cols: 80,
    rows: 24,
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: p.fontSize,
    lineHeight: 1.15,
    scrollback: p.scrollback,
    cursorBlink: p.blink,
    cursorStyle: 'block',
    convertEol: true,
    windowsMode: navigator.userAgent.includes('Windows'),
    theme: TERM_THEME,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => {
    if (/^https?:\/\//i.test(uri)) void barang().app.openExternal(uri).catch(() => undefined);
  }));
  const mount = el('div', { class: 'term-mount' });
  colEls[col]?.append(mount);
  term.open(mount);
  const rec: TermRec = {
    id: info.id, shell: info.shell, cwd: info.cwd, col, dead: false, exitCode: null,
    term, fit, search, mount, tab: document.createElement('button'),
  };
  term.onData((data) => {
    void barang().term.write(rec.id, data).catch(() => undefined);
  });
  // VSCode key semantics: selection-aware copy, paste, find. Everything else
  // (arrows, Tab, Ctrl+Z/C-without-selection…) flows to the shell untouched.
  term.attachCustomKeyEventHandler((e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Insert' && e.shiftKey && !mod) {
      void pasteTo(rec);
      return false;
    }
    if (e.key === 'Insert' && mod && !e.shiftKey) {
      void copySel(rec);
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      void copySel(rec);
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
      void pasteTo(rec);
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      openFind();
      return false;
    }
    return true;
  });
  term.onBell(() => {
    rec.tab.classList.add('is-bell');
    if (rec.bellTimer) clearTimeout(rec.bellTimer);
    rec.bellTimer = setTimeout(() => rec.tab.classList.remove('is-bell'), 1200);
  });
  // Focus tracking for global keybindings (a focused shell owns its keys).
  // xterm exposes the hidden textarea it listens on — focus events there.
  term.textarea?.addEventListener('focus', () => { focusedCount++; });
  term.textarea?.addEventListener('blur', () => { focusedCount = Math.max(0, focusedCount - 1); });
  new ResizeObserver(() => scheduleFit()).observe(mount);
  mount.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const hasSel = term.hasSelection();
    showContextMenu(e.clientX, e.clientY, [
      ...(hasSel ? [{ label: 'Copy', icon: 'clip' as const, run: () => void copySel(rec) }] : []),
      { label: 'Paste', icon: 'clip' as const, run: () => void pasteTo(rec) },
      { label: 'Clear', icon: 'x' as const, run: () => rec.term.clear() },
      { sep: true },
      { label: 'Split Right', icon: 'splitV' as const, run: () => void newTerminal({ focus: true }) },
      { label: 'Kill Terminal', icon: 'trash' as const, run: () => void killTerm(rec.id, true) },
    ]);
  });
  // Click focuses the shell (VSCode behavior).
  mount.addEventListener('mousedown', () => {
    activeId = rec.id;
    paintTabs();
  });
  terms.push(rec);
  activeId = rec.id;
  paintTabs();
  setOpen(true);
  try {
    fit.fit();
    await reportSize(rec);
  } catch {
    /* headless/small mount */
  }
  if (opts.focus !== false) term.focus();
}

async function copySel(t: TermRec): Promise<void> {
  const text = t.term.getSelection();
  t.term.clearSelection();
  if (!text) return;
  try {
    await barang().clip.write(text);
  } catch {
    hooksRef.toast('Copy failed.', 'error');
  }
}

async function pasteTo(t: TermRec): Promise<void> {
  try {
    const { text } = await barang().clip.read();
    if (text) await barang().term.write(t.id, text);
  } catch {
    /* clipboard unavailable */
  }
}

function setOpen(open: boolean): void {
  panelEl?.classList.toggle('hidden', !open);
  try {
    localStorage.setItem(LS_OPEN, open ? '1' : '0');
  } catch {
    /* private mode */
  }
  if (open) {
    // Hidden mounts measure 0 — fit after the panel paints.
    requestAnimationFrame(() => scheduleFit());
    window.dispatchEvent(new Event('resize')); // Monaco re-layout
  } else {
    closeFind();
    window.dispatchEvent(new Event('resize'));
  }
  emit();
}

export function isOpen(): boolean {
  return !!panelEl && !panelEl.classList.contains('hidden');
}

export function hasFocus(): boolean {
  return focusedCount > 0;
}

function openFind(): void {
  if (!findEl || !findInput || !active()) return;
  findEl.classList.remove('hidden');
  findInput.value = active()?.term.getSelection() || findInput.value;
  findInput.focus();
  findInput.select();
  runFind(true);
}

function closeFind(): void {
  findEl?.classList.add('hidden');
  active()?.search.clearDecorations();
  active()?.term.focus();
}

function runFind(next: boolean): void {
  const t = active();
  const q = findInput?.value ?? '';
  if (!t || !q) {
    if (findCount) findCount.textContent = '';
    return;
  }
  const found = next
    ? t.search.findNext(q, { incremental: true })
    : t.search.findPrevious(q, { incremental: true });
  if (!found && findCount) findCount.textContent = '0';
}

export function initTerminal(host: HTMLElement, hooks: TerminalHooks) {
  hooksRef = hooks;
  panelEl = host;
  host.classList.add('hidden');

  const grip = el('div', { class: 'term-grip', title: 'Drag to resize' });
  const head = el('div', { class: 'term-head' });
  tabsEl = el('div', { class: 'term-tabs' });
  head.append(tabsEl);

  // Find widget (Ctrl+F in terminal).
  findEl = el('div', { class: 'term-find hidden' });
  findInput = el('input', { class: 'term-find-input', placeholder: 'Find', 'aria-label': 'Find in terminal' }) as HTMLInputElement;
  const btnPrev = el('button', { class: 'icon-btn', title: 'Previous (Shift+Enter)' }) as HTMLButtonElement;
  btnPrev.append(iconEl('chevL', 13));
  const btnNext = el('button', { class: 'icon-btn', title: 'Next (Enter)' }) as HTMLButtonElement;
  btnNext.append(iconEl('chevR', 13));
  findCount = el('span', { class: 'term-find-count' });
  const btnFindX = el('button', { class: 'icon-btn', title: 'Close (Esc)' }) as HTMLButtonElement;
  btnFindX.append(iconEl('x', 13));
  findEl.append(findInput, btnPrev, btnNext, findCount, btnFindX);
  findInput.addEventListener('input', () => runFind(true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  btnPrev.onclick = () => runFind(false);
  btnNext.onclick = () => runFind(true);
  btnFindX.onclick = closeFind;
  head.append(findEl);

  const actions = el('div', { class: 'term-actions' });
  const mkBtn = (icon: IconName, title: string, run: () => void) => {
    const b = el('button', { class: 'icon-btn term-action', title }) as HTMLButtonElement;
    b.append(iconEl(icon, 14));
    b.onclick = run;
    actions.append(b);
    return b;
  };
  const btnNew = mkBtn('plus', 'New terminal (Ctrl+Shift+`)', () => void newTerminal({ focus: true }));
  btnNew.classList.add('term-action-new');
  mkBtn('splitV', 'Split terminal right', () => void newTerminal({ focus: true }));
  mkBtn('x', 'Clear', () => active()?.term.clear());
  mkBtn('trash', 'Kill active terminal', () => {
    if (activeId) void killTerm(activeId, true);
  });
  const btnMax = mkBtn('maximize', 'Maximize panel', () => {
    host.classList.toggle('maximized');
    scheduleFit();
  });
  const btnHide = mkBtn('chevD', 'Hide panel (Ctrl+`)', () => setOpen(false));
  btnHide.classList.add('term-action-hide');
  void btnMax;
  head.append(actions);

  bodyEl = el('div', { class: 'term-body' });
  colEls = [el('div', { class: 'term-col', 'data-col': '0' }), el('div', { class: 'term-col hidden', 'data-col': '1' })];
  emptyEl = el('div', { class: 'term-empty' });
  const btnEmpty = el('button', { class: 'btn btn-sm' }, 'New terminal') as HTMLButtonElement;
  btnEmpty.onclick = () => void newTerminal({ focus: true });
  emptyEl.append(el('span', {}, 'No terminals open.'), btnEmpty);
  bodyEl.append(...colEls, emptyEl);
  host.append(grip, head, bodyEl);

  // Drag-resize (height persists; double-click resets).
  let dragY = 0;
  let dragH = 0;
  try {
    const saved = parseInt(localStorage.getItem(LS_H) || '', 10);
    if (Number.isFinite(saved)) host.style.height = `${Math.max(120, Math.min(window.innerHeight * 0.7, saved))}px`;
  } catch {
    /* fresh default from CSS */
  }
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragY = e.clientY;
    dragH = host.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      const h = Math.max(120, Math.min(window.innerHeight * 0.7, dragH + (dragY - ev.clientY)));
      host.style.height = `${h}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem(LS_H, String(host.getBoundingClientRect().height));
      } catch {
        /* noop */
      }
      scheduleFit();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  grip.addEventListener('dblclick', () => {
    host.style.removeProperty('height');
    try {
      localStorage.removeItem(LS_H);
    } catch {
      /* noop */
    }
    scheduleFit();
  });

  // Backend events: route output, track exits (typed `exit` keeps a dead tab).
  barang().term.onData(({ id, data }) => {
    terms.find((t) => t.id === id)?.term.write(data);
  });
  barang().term.onExit(({ id, code }) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return; // disposed by user kill — nothing to show
    t.dead = true;
    t.exitCode = code;
    try {
      t.term.writeln(`\r\n\x1b[2m[process exited with code ${code ?? '?'} — double-click tab to relaunch]\x1b[0m`);
    } catch {
      /* closing */
    }
    paintTabs();
  });

  // Restore open state (terminals themselves start fresh, like VSCode).
  try {
    if (localStorage.getItem(LS_OPEN) === '1') setOpen(true);
  } catch {
    /* stay closed */
  }
  paintTabs();

  // Headless/smoke introspection: buffer text of a terminal (read-only).
  (window as unknown as { __barangTermBuffer: (id: string) => string | null }).__barangTermBuffer = (id: string) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return null;
    try {
      const b = t.term.buffer.active;
      let out = '';
      for (let i = 0; i < b.length; i++) out += b.getLine(i)?.translateToString(true) ?? '' + '\n';
      return out;
    } catch {
      return null;
    }
  };

  return {
    toggle: () => {
      const next = !isOpen();
      if (next && terms.length === 0) void newTerminal({ focus: true });
      else setOpen(next);
      if (next) active()?.term.focus();
    },
    isOpen,
    hasFocus,
    newTerminal: (focus = true) => newTerminal({ focus }),
    clearActive: () => active()?.term.clear(),
    killActive: () => {
      if (activeId) void killTerm(activeId, true);
    },
    focusActive: () => active()?.term.focus(),
    onChange: (cb: (info: { count: number; open: boolean }) => void) => {
      onChangeCb = cb;
      emit();
    },
  };
}

export type TerminalApi = ReturnType<typeof initTerminal>;
