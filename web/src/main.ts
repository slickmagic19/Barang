// Barang shell: layout, wiring, keybindings. Framework-free on purpose:
// the whole interactive shell (minus editor + agent logic) is this file.
import './styles.css';
import { appState } from './lib/api';
import { barang } from './lib/transport';
import { connectEvents, agentStore, createSession, loadMeta } from './lib/agent';
import { el } from './lib/util';
import { iconEl } from './ui/icons';
import { openSettings } from './ui/settings';
import logoUrl from './assets/barang-logo.png';

function logoImg(size: number, cls = ''): HTMLImageElement {
  const img = el('img', { class: `brand-logo ${cls}`.trim(), src: logoUrl, alt: 'Barang logo', width: String(size), height: String(size) }) as HTMLImageElement;
  return img;
}
import { initExplorer, refreshExplorer, revealInTree } from './ui/explorer';
import { initEditor, openFile, showDiffTab, closeTab, closeOtherTabs, closeAllTabs, closeSavedTabs, closePathAndChildren, saveActive, saveAll, checkExternalChanges, editorStore } from './ui/editor';
import { initChat } from './ui/chat';
import { initPalette } from './ui/palette';
import { initStatusbar } from './ui/statusbar';
import { showContextMenu } from './ui/menu';
import { fsApi } from './lib/api';
import { copyText } from './lib/util';

function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const host = document.getElementById('toasts')!;
  const t = el('div', { class: `toast is-${kind}` });
  t.append(iconEl(kind === 'error' ? 'alert' : 'info', 15), el('span', {}, msg));
  host.append(t);
  setTimeout(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, kind === 'error' ? 7000 : 4000);
  // Errors also surface in console for debugging.
  if (kind === 'error') console.error('[barang]', msg);
}

/** Drag-to-resize for sidebar + agent panel. Widths live in CSS vars and
 *  persist to localStorage; double-click a gutter to reset. */
function initResizable(gutterL: HTMLElement, gutterR: HTMLElement) {
  const KEY = 'barang:layout-v1';
  const DEFAULTS = { side: 264, agent: 372 };
  const MIN = { side: 170, agent: 280 };
  let saved: { side: number; agent: number } = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Number.isFinite(p.side)) saved.side = Math.max(MIN.side, Math.min(p.side, 560));
      if (Number.isFinite(p.agent)) saved.agent = Math.max(MIN.agent, Math.min(p.agent, 720));
    }
  } catch { /* fresh defaults */ }
  const apply = () => {
    document.documentElement.style.setProperty('--side-w', `${saved.side}px`);
    document.documentElement.style.setProperty('--agent-w', `${saved.agent}px`);
  };
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch { /* private mode etc. */ }
  };
  apply();

  const drag = (gutter: HTMLElement, key: 'side' | 'agent', dir: 1 | -1) => {
    gutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gutter.classList.add('dragging');
      gutter.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = saved[key];
      const move = (ev: PointerEvent) => {
        const max = Math.min(key === 'side' ? 560 : 720, window.innerWidth - 560);
        saved[key] = Math.max(MIN[key], Math.min(startW + (ev.clientX - startX) * dir, max));
        apply();
      };
      const up = () => {
        gutter.classList.remove('dragging');
        gutter.removeEventListener('pointermove', move);
        persist();
        window.dispatchEvent(new Event('resize')); // Monaco re-layout
      };
      gutter.addEventListener('pointermove', move);
      gutter.addEventListener('pointerup', up, { once: true });
      gutter.addEventListener('pointercancel', up, { once: true });
    });
    gutter.addEventListener('dblclick', () => {
      saved[key] = DEFAULTS[key];
      apply();
      persist();
      window.dispatchEvent(new Event('resize'));
    });
  };
  // Left gutter: dragging right widens the sidebar. Right gutter: dragging
  // left widens the agent panel.
  drag(gutterL, 'side', 1);
  drag(gutterR, 'agent', -1);
}

async function boot() {
  const app = document.getElementById('app')!;

  // --- layout -----------------------------------------------------------
  const topbar = el('div', { class: 'topbar' });
  const brand = el('div', { class: 'brand' });
  brand.append(logoImg(20), el('span', { class: 'brand-name' }, 'Barang'));
  const topActions = el('div', { class: 'top-actions' });
  const btnFolder = el('button', { class: 'top-btn', title: 'Open folder (Ctrl+O)' }) as HTMLButtonElement;
  btnFolder.append(iconEl('folder', 14), el('span', {}, 'Open'));
  const btnPalette = el('button', { class: 'top-btn', title: 'Command palette (Ctrl+Shift+P)' }) as HTMLButtonElement;
  btnPalette.append(iconEl('prompt', 14), el('span', {}, 'Palette'));
  const btnAgent = el('button', { class: 'top-btn', title: 'Toggle agent panel (Ctrl+`)' }) as HTMLButtonElement;
  btnAgent.append(iconEl('spark', 14), el('span', {}, 'Agent'));
  const btnSettings = el('button', { class: 'top-btn settings-btn', title: 'Settings' }) as HTMLButtonElement;
  btnSettings.append(iconEl('gear', 15));
  topActions.append(btnFolder, btnPalette, btnAgent, btnSettings);
  const openFolderFlow = () => {
    try {
      void barang().app.openFolder().catch((e) => {
        if (!/cancelled/i.test((e as Error).message)) toast((e as Error).message, 'error');
      });
      // Main restarts `opencode serve` on the new root and sends
      // 'root-changed' — the UI reloads there. Nothing else to do here.
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const openPathFlow = (path: string) => {
    try {
      void barang().app.openPath(path).catch((e) => toast((e as Error).message, 'error'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  btnFolder.onclick = openFolderFlow;
  btnSettings.onclick = () => openSettings({ toast });
  const ocBanner = el('div', { class: 'oc-banner hidden' });
  topbar.append(brand, ocBanner, topActions);

  const main = el('div', { class: 'main' });
  const sidebar = el('div', { class: 'sidebar' });
  const gutterL = el('div', { class: 'gutter-v', title: 'Drag to resize · double-click to reset' });
  const center = el('div', { class: 'center' });
  const tabs = el('div', { class: 'tabs' });
  const editorHost = el('div', { class: 'editor-host' });
  const welcome = el('div', { class: 'welcome' });
  welcome.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-logo"></div>
      <h1>Barang</h1>
      <p class="sub">Coding Black Magic</p>
      <div class="welcome-grid">
        <div><kbd>Ctrl+P</kbd><span>quick open</span></div>
        <div><kbd>Ctrl+Shift+P</kbd><span>commands</span></div>
        <div><kbd>Ctrl+Shift+F</kbd><span>search in files</span></div>
        <div><kbd>Enter</kbd><span>send to agent</span></div>
        <div><kbd>Ctrl+S</kbd><span>save file</span></div>
        <div><kbd>Ctrl+\`</kbd><span>agent panel</span></div>
      </div>
    </div>`;
  (welcome.querySelector('.welcome-logo') as HTMLElement).append(logoImg(52));
  center.append(tabs, editorHost, welcome);

  // Welcome extras: open entry points + recent projects (from app state below
  // once loaded — painted by paintWelcome()).
  const welcomeActions = el('div', { class: 'welcome-actions' });
  const btnWelcomeOpen = el('button', { class: 'btn btn-primary' }, 'Open folder') as HTMLButtonElement;
  btnWelcomeOpen.prepend(iconEl('folder', 14));
  btnWelcomeOpen.onclick = openFolderFlow;
  welcomeActions.append(btnWelcomeOpen);
  const welcomeRecent = el('div', { class: 'welcome-recent hidden' });
  welcome.querySelector('.welcome-inner')?.append(welcomeActions, welcomeRecent);

  const paintWelcome = (recents: string[]) => {
    welcomeRecent.innerHTML = '';
    if (!recents.length) {
      welcomeRecent.classList.add('hidden');
      return;
    }
    welcomeRecent.classList.remove('hidden');
    welcomeRecent.append(el('p', { class: 'welcome-recent-label' }, 'Recent'));
    for (const r of recents.slice(0, 5)) {
      const b = el('button', { class: 'recent-row' }) as HTMLButtonElement;
      b.append(iconEl('folder', 14));
      const txt = el('span', { class: 'recent-text' });
      txt.append(
        el('span', { class: 'recent-name' }, r.split(/[\\/]/).filter(Boolean).pop() || r),
        el('span', { class: 'recent-path' }, r),
      );
      b.append(txt);
      b.title = r;
      b.onclick = () => openPathFlow(r);
      welcomeRecent.append(b);
    }
  };

  const agentPanel = el('div', { class: 'agent-wrap' });
  const gutterR = el('div', { class: 'gutter-v', title: 'Drag to resize · double-click to reset' });
  main.append(sidebar, gutterL, center, gutterR, agentPanel);
  initResizable(gutterL, gutterR);

  // Collapsible explorer rail (Ctrl+B). Distinct from `.collapsed`, which is
  // the welcome state (whole sidebar gone until a project opens).
  const railBtn = el('button', { class: 'icon-btn rail-btn', title: 'Show explorer (Ctrl+B)' }) as HTMLButtonElement;
  railBtn.append(iconEl('chevR', 15));
  sidebar.prepend(railBtn);
  const setSideRail = (on: boolean) => {
    sidebar.classList.toggle('rail', on);
    try {
      localStorage.setItem('barang:side-rail', on ? '1' : '0');
    } catch { /* private mode etc. */ }
    window.dispatchEvent(new Event('resize')); // Monaco re-layout
  };
  const toggleSideRail = () => {
    if (!hasProject) {
      toast('Open a folder to browse files.', 'info');
      return;
    }
    setSideRail(!sidebar.classList.contains('rail'));
  };
  railBtn.onclick = () => setSideRail(false);
  const statusbar = el('div', { class: 'statusbar' });
  const toasts = el('div', { id: 'toasts' });
  app.append(topbar, main, statusbar, toasts);

  // --- desktop backend state ------------------------------------------
  if (!window.barang) {
    throw new Error('Barang desktop bridge is missing — open Barang from the desktop app, not a browser tab.');
  }
  let root = '';
  let opencodeOk = false;
  let opencodeVersion: string | null = null;
  let appRecents: string[] = [];
  try {
    const st = await appState();
    root = st.root;
    appRecents = st.recent ?? [];
    agentStore.set({ root }); // scopes chat sessions to this project
    opencodeOk = st.opencode.running;
    opencodeVersion = st.opencode.version ?? st.opencode.cli ?? null;
    paintWelcome(appRecents);
  } catch (e) {
    toast(`Desktop backend unreachable: ${(e as Error).message}`, 'error');
  }
  if (!opencodeOk) {
    ocBanner.append(
      iconEl('alert', 14),
      el('span', {}, 'opencode CLI not detected — install it: '),
      el('code', {}, 'npm install -g opencode-ai'),
      el('span', {}, ', then restart Barang. Editing still works; the agent is offline.'),
    );
    ocBanner.classList.remove('hidden');
  }

  // Welcome state (no project): only the center shows. Explorer and agent
  // appear once a folder is opened (which reloads into the project layout).
  const hasProject = root !== '';
  if (!hasProject) {
    sidebar.classList.add('collapsed');
    agentPanel.classList.add('collapsed');
  } else {
    // Restore the explorer rail preference (project layout only).
    try {
      if (localStorage.getItem('barang:side-rail') === '1') {
        sidebar.classList.add('rail');
        window.dispatchEvent(new Event('resize'));
      }
    } catch { /* fresh defaults */ }
  }

  const status = initStatusbar(statusbar, { root, opencodeVersion, opencodeOk });

  const paintTabs = () => {
    const { tabs: ts, active } = editorStore.get();
    tabs.innerHTML = '';
    welcome.classList.toggle('hidden', ts.length > 0);
    editorHost.classList.toggle('hidden', ts.length === 0);
    for (const t of ts) {
      const file = t.file ?? t.path;
      const name = file.split('/').pop() || file;
      const isDiff = !!t.diff;
      const b = el('button', {
        class: `tab${t.path === active ? ' active' : ''}${isDiff ? ' is-diff' : ''}`,
        title: isDiff ? `${file} — session changes (read-only review)` : t.path,
        'data-path': t.path,
      }) as HTMLButtonElement;
      if (isDiff) b.append(el('span', { class: 'diff-badge' }, 'changes'));
      b.append(el('span', { class: 'tab-name' }, name));
      if (t.dirty) b.append(el('span', { class: 'dirty-dot', title: 'Unsaved changes' }));
      b.onclick = () => {
        if (t.diff) showDiffTab(t.path);
        else void openFile(t.path);
      };
      b.onauxclick = (e) => {
        if (e.button === 1) closeTab(t.path);
      };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = t.path;
        const f = t.file ?? t.path;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Close', icon: 'x', run: () => closeTab(p) },
          { label: 'Close Others', icon: 'x', run: () => closeOtherTabs(p) },
          { label: 'Close Saved', icon: 'check', run: () => closeSavedTabs() },
          { label: 'Close All', icon: 'x', run: () => closeAllTabs() },
          { sep: true },
          {
            label: 'Copy Path', icon: 'file',
            run: () => void copyText(f).then((ok) => toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')),
          },
          { label: 'Reveal in Explorer', icon: 'folder', run: () => void revealInTree(f) },
        ]);
      };
      const x = el('span', { class: 'tab-x', title: 'Close' });
      x.append(iconEl('x', 12));
      x.onclick = (e) => {
        e.stopPropagation();
        closeTab(t.path);
      };
      b.append(x);
      tabs.append(b);
    }
  };
  editorStore.subscribe(paintTabs);

  await initEditor(editorHost, {
    onCursor: (p) => status.setCursor(p.line, p.col),
    onTabs: paintTabs,
    toast,
  });
  paintTabs();

  const explorer = initExplorer(sidebar, {
    onOpenFile: (p) => void openFile(p),
    onOpenFolder: openFolderFlow,
    onCollapseSidebar: () => setSideRail(true),
    onPathRenamed: (from, to) => {
      // A renamed file moves its tab along (dirty tab asks first);
      // a renamed folder closes orphaned child tabs (one confirm if dirty).
      if (editorStore.get().tabs.some((t) => t.path === from)) {
        closeTab(from);
        closePathAndChildren(`diff:${from}`); // drop its stale review tab too
        if (!editorStore.get().tabs.some((t) => t.path === from)) void openFile(to);
      } else {
        closePathAndChildren(from);
      }
      refreshExplorer();
      explorer.repaint();
    },
    onPathRemoved: (p) => {
      void (async () => {
        try {
          if (!closePathAndChildren(p)) return; // user cancelled (dirty tabs)
          await fsApi.remove(p);
          refreshExplorer();
          explorer.repaint();
          toast(`Deleted ${p}.`, 'info');
        } catch (e) {
          toast(`Delete failed: ${(e as Error).message}`, 'error');
        }
      })();
    },
    toast,
  }, root);

  initChat(agentPanel, { toast });
  connectEvents();
  // Model/agent catalog + free-model defaults (Muse Spark when available).
  void loadMeta().catch((e) => toast(`opencode metadata: ${e.message}`, 'error'));

  const toggleAgent = () => {
    if (!hasProject) {
      toast('Open a folder to use the agent panel.', 'info');
      return;
    }
    agentPanel.classList.toggle('collapsed');
    // Monaco needs an explicit layout nudge after flex changes.
    window.dispatchEvent(new Event('resize'));
  };

  const palette = initPalette({
    newSession: () => void createSession().catch((e) => toast(e.message, 'error')),
    saveAll: () => void saveAll(),
    toggleAgent,
    refreshExplorer: () => {
      refreshExplorer();
      explorer.repaint();
    },
    openRecent: (path) => openPathFlow(path),
    getRecents: () => appRecents,
    toast,
  });

  btnPalette.onclick = () => (palette.isOpen() ? palette.close() : palette.open('> '));
  btnAgent.onclick = toggleAgent;

  // Native events from main (no app menu: topbar owns these actions).
  // Only 'root-changed' still arrives — Open Folder restarts the agent
  // server on the new root, then tells us to reload.
  try {
    barang().app.onMenu((kind) => {
      if (kind === 'root-changed') location.reload();
    });
  } catch (e) {
    toast((e as Error).message, 'error');
  }

  // --- keybindings -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open('');
    } else if (mod && e.key.toLowerCase() === 'p' && e.shiftKey) {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open('> ');
    } else if (mod && e.key.toLowerCase() === 'f' && e.shiftKey) {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open('# ');
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveActive().then((ok) => {
        if (ok) toast('Saved', 'info');
      });
    } else if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSideRail();
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openFolderFlow();
    } else if (mod && e.key === '`') {
      e.preventDefault();
      toggleAgent();
    } else if (e.key === 'Escape' && palette.isOpen()) {
      palette.close();
    }
  });

  // Suppress the native right-click menu everywhere except editable text
  // and Monaco (which owns its own menu). Custom menus preventDefault first.
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .monaco-menu')) return;
    e.preventDefault();
  });

  // Agent edits land on disk behind our back — resync clean tabs on focus.
  window.addEventListener('focus', () => {
    void checkExternalChanges().then(() => {
      refreshExplorer();
      explorer.repaint();
    });
  });

  // Keep the "agent changed files" loop tight while busy too.
  agentStore.subscribe(() => {
    if (!agentStore.get().busy) {
      void checkExternalChanges();
      refreshExplorer();
      explorer.repaint();
    }
  });

  if (opencodeOk) toast(`Connected to opencode ${opencodeVersion ?? ''} — agent online`, 'info');
}

boot().catch((e) => {
  document.getElementById('app')!.innerHTML =
    `<div style="padding:32px;font-family:system-ui">Failed to start Barang: ${String(e?.message || e)}</div>`;
  console.error(e);
});
