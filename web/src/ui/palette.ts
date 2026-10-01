// Command palette: Ctrl+P files · Ctrl+Shift+P commands · Ctrl+Shift+F text search.
// Prefix inside palette: "> " commands, "# " text search, otherwise file search.
import { fsApi } from '../lib/api';
import { el, debounce } from '../lib/util';
import { iconEl, type IconName } from './icons';
import { fileIconEl } from './fileIcons';
import { revealInEditor } from './editor';

export interface PaletteHooks {
  newSession(): void;
  saveAll(): void;
  toggleAgent(): void;
  toggleTerminalPanel(): void;
  terminalNew(): void;
  terminalClear(): void;
  terminalKill(): void;
  refreshExplorer(): void;
  openRecent(path: string): void;
  getRecents(): string[];
  toast(msg: string, kind?: 'info' | 'error'): void;
}

const COMMANDS = [
  { id: 'session.new', label: 'Agent: New session' },
  { id: 'agent.toggle', label: 'View: Toggle agent panel' },
  { id: 'terminal.toggle', label: 'Terminal: Toggle panel' },
  { id: 'terminal.new', label: 'Terminal: New terminal' },
  { id: 'terminal.clear', label: 'Terminal: Clear' },
  { id: 'terminal.kill', label: 'Terminal: Kill active' },
  { id: 'file.saveAll', label: 'File: Save all' },
  { id: 'file.openRecent', label: 'File: Open recent…' },
  { id: 'explorer.refresh', label: 'Explorer: Refresh' },
  { id: 'help.shortcuts', label: 'Help: Keyboard shortcuts' },
];

const SHORTCUTS = `Ctrl+P — quick open · Ctrl+Shift+P — commands · Ctrl+Shift+F — search in files
Enter — send agent message · Shift+Enter — newline · Ctrl+S — save file · Ctrl+Shift+S — save all
Ctrl+N — new untitled tab · Ctrl+W — close tab · Ctrl+B — explorer · Ctrl+J — agent panel
Ctrl+\` — terminal · Ctrl+Shift+\` — new terminal · Ctrl+C/V — copy/paste in terminal · Ctrl+F — find in terminal
Delete — delete focused file · @ — attach file in agent input · Esc — close palette`;

export function initPalette(hooks: PaletteHooks) {
  const overlay = el('div', { class: 'palette-overlay hidden' });
  const box = el('div', { class: 'palette' });
  const inputWrap = el('div', { class: 'palette-input-wrap' });
  inputWrap.append(iconEl('search', 15));
  const input = el('input', { class: 'palette-input', placeholder: 'File name, > commands, # search, ~ recent' }) as HTMLInputElement;
  inputWrap.append(input);
  const results = el('div', { class: 'palette-results' });
  const foot = el('div', { class: 'palette-foot' });
  foot.append(el('span', {}, '↑↓ navigate'), el('span', {}, 'Enter open'), el('span', {}, 'Esc close'));
  box.append(inputWrap, results, foot);
  overlay.append(box);
  document.body.append(overlay);

  let mode: 'files' | 'commands' | 'search' = 'files';
  let items: Array<{ label: string; sub?: string; icon?: IconName; glyph?: HTMLElement; run(): void }> = [];
  let idx = 0;

  const paint = () => {
    results.innerHTML = '';
    items.slice(0, 30).forEach((it, i) => {
      const b = el('button', { class: `palette-item${i === idx ? ' active' : ''}` });
      const glyph = it.glyph ?? iconEl(it.icon ?? 'file', 14);
      b.append(glyph, el('span', { class: 'palette-label' }, it.label));
      if (it.sub) b.append(el('span', { class: 'palette-sub' }, it.sub));
      b.onclick = () => {
        close();
        it.run();
      };
      b.onmousemove = () => {
        if (idx !== i) {
          idx = i;
          paint();
        }
      };
      results.append(b);
    });
    results.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  };

  const searchFiles = debounce(async (q: string) => {
    try {
      const r = await fsApi.find(q || '', 30);
      items = r.results.map((f) => ({ label: f.path, glyph: fileIconEl(f.path.split('/').pop() ?? f.path, 14), run: () => revealInEditor(f.path) }));
    } catch {
      items = [{ label: 'Search failed', run: () => {} }];
    }
    idx = 0;
    paint();
  }, 150);

  const searchText = debounce(async (q: string) => {
    if (!q.trim()) {
      items = [];
      paint();
      return;
    }
    try {
      const r = await fsApi.search(q.trim(), '', 40);
      items = r.results.map((m) => ({
        label: `${m.path}:${m.line}`,
        sub: m.text,
        glyph: fileIconEl(m.path.split('/').pop() ?? m.path, 14),
        run: () => revealInEditor(m.path, m.line),
      }));
      if (!items.length) items = [{ label: `No matches (${r.engine})`, run: () => {} }];
    } catch {
      items = [{ label: 'Search failed', run: () => {} }];
    }
    idx = 0;
    paint();
  }, 250);

  const update = () => {
    const v = input.value;
    if (v.startsWith('>')) {
      mode = 'commands';
      const q = v.slice(1).trim().toLowerCase();
      items = COMMANDS.filter((c) => c.label.toLowerCase().includes(q)).map((c) => ({
        label: c.label,
        icon: 'prompt' as IconName,
        run: () => runCommand(c.id),
      }));
      idx = 0;
      paint();
    } else if (v.startsWith('~')) {
      // Recent projects (typed or via File: Open Recent).
      mode = 'search';
      const q = v.slice(1).trim().toLowerCase();
      const recents = hooks.getRecents().filter((r) => r.toLowerCase().includes(q));
      items = recents.map((r) => ({
        label: r.split(/[\\/]/).filter(Boolean).pop() || r,
        sub: r,
        icon: 'folder' as IconName,
        run: () => hooks.openRecent(r),
      }));
      if (!items.length) items = [{ label: 'No recent projects', run: () => {} }];
      idx = 0;
      paint();
    } else if (v.startsWith('#')) {
      mode = 'search';
      void searchText(v.slice(1));
    } else {
      mode = 'files';
      void searchFiles(v.trim());
    }
    void mode;
  };

  const runCommand = (id: string) => {
    if (id === 'session.new') hooks.newSession();
    else if (id === 'agent.toggle') hooks.toggleAgent();
    else if (id === 'terminal.toggle') hooks.toggleTerminalPanel();
    else if (id === 'terminal.new') hooks.terminalNew();
    else if (id === 'terminal.clear') hooks.terminalClear();
    else if (id === 'terminal.kill') hooks.terminalKill();
    else if (id === 'file.saveAll') void hooks.saveAll();
    else if (id === 'file.openRecent') open('~ ');
    else if (id === 'explorer.refresh') hooks.refreshExplorer();
    else if (id === 'help.shortcuts') hooks.toast(SHORTCUTS, 'info');
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(idx + 1, items.length - 1);
      paint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(idx - 1, 0);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[idx];
      close();
      it?.run();
    } else if (e.key === 'Escape') close();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  function open(prefill = '') {
    overlay.classList.remove('hidden');
    input.value = prefill;
    idx = 0;
    items = [];
    input.focus();
    input.select();
    update();
  }
  function close() {
    overlay.classList.add('hidden');
  }
  function isOpen() {
    return !overlay.classList.contains('hidden');
  }
  return { open, close, isOpen };
}
