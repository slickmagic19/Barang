// Barang shell: layout, wiring, keybindings. Framework-free on purpose:
// the whole interactive shell (minus editor + agent logic) is this file.
import './styles.css';
import { appState } from './lib/api';
import { barang } from './lib/transport';
import { connectEvents, agentStore, createSession, loadMeta, loadSessions, readSettings, shouldAutoCreateSession, pickDefaultModel, fmtTokens, sessionUsage, isRetryableSendError, withSendRetries, sanitizeOutgoingFiles, resolveSendModel, statusTextFor, messageErrorText, decideStalled,   permissionFromEvent, parseAgentEvent, isTransportDown, findUserMessage, todoProgress,
  questionFromEvent, describeActivity, decideStatus, shortenMiddle, classifyAttachFile } from './lib/agent';
import { sliceWindow, truncateText } from './lib/util';
import { watchAgentNotifications, playNotificationSound, resolveSoundUrl, activeSessionTitle, decideAgentNotification, armAudioUnlock, type NotifyKind } from './lib/notify';
import { el, debounce, copyText } from './lib/util';
import { iconEl } from './ui/icons';
import { fileIconEl } from './ui/fileIcons';
import { openSettings } from './ui/settings';
import logoUrl from './assets/barang-logo.png';

function logoImg(size: number, cls = ''): HTMLImageElement {
  const img = el('img', { class: `brand-logo ${cls}`.trim(), src: logoUrl, alt: 'Barang logo', width: String(size), height: String(size) }) as HTMLImageElement;
  return img;
}
import { initExplorer, refreshExplorer, revealInTree, resetExplorerState, clearFocusedEntry, deleteFocusedEntry } from './ui/explorer';
import { initEditor, openFile, openUntitled, showDiffTab, closeTab, closeOtherTabs, closeAllTabs, closeSavedTabs, closePathAndChildren, saveActive, saveAll, checkExternalChanges, editorStore, revealInEditor } from './ui/editor';
import { initChat } from './ui/chat';
import { initPalette } from './ui/palette';
import { initTerminal, type TerminalApi } from './ui/terminal';
import { initScm, decoration, type ScmApi } from './ui/scm';
import { initSearchView, highlightLine, type SearchApi } from './ui/search';
import { initBolt, substituteVars, buildUrl, parseUrlParams, prettyBody, highlightJson, headerValueSuggestions, COMMON_HEADER_NAMES, type BoltApi } from './ui/bolt';
import { initStatusbar } from './ui/statusbar';
import { showContextMenu } from './ui/menu';
import { fsApi } from './lib/api';

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
  const btnRecent = el('button', { class: 'top-btn top-split-chev', title: 'Recent projects' }) as HTMLButtonElement;
  btnRecent.append(iconEl('chevD', 13));
  btnRecent.onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const recents = appRecents.filter((p) => p !== root);
    showContextMenu(r.left, r.bottom + 6, [
      { label: 'Open folder…', icon: 'folder', run: () => openFolderFlow() },
      { sep: true },
      ...(recents.length
        ? recents.slice(0, 8).map((p) => ({
            label: p,
            icon: 'history' as const,
            run: () => openPathFlow(p),
          }))
        : [{ label: 'No recent projects', run: () => {} }]),
    ]);
  };
  const openSplit = el('div', { class: 'top-split' });
  openSplit.append(btnFolder, btnRecent);
  const btnPalette = el('button', { class: 'top-btn', title: 'Command palette (Ctrl+Shift+P)' }) as HTMLButtonElement;
  btnPalette.append(iconEl('prompt', 14), el('span', {}, 'Palette'));
  const btnAgent = el('button', { class: 'top-btn', title: 'Toggle agent panel (Ctrl+J)' }) as HTMLButtonElement;
  btnAgent.append(iconEl('spark', 14), el('span', {}, 'Agent'));
  const btnSettings = el('button', { class: 'top-btn settings-btn', title: 'Settings' }) as HTMLButtonElement;
  btnSettings.append(iconEl('gear', 15));
  const btnUpdate = el('button', { class: 'top-btn update-btn', title: 'Check for updates' }) as HTMLButtonElement;
  btnUpdate.append(iconEl('download', 14));
  const updateDot = el('span', { class: 'update-dot hidden', title: 'Update available' });
  btnUpdate.append(updateDot);
  topActions.append(openSplit, btnPalette, btnAgent, btnSettings, btnUpdate);

  // Update checker (opencode-style): badge when a newer release exists,
  // popover with the download link. Silent when offline.
  let updateInfo: { update: boolean; current: string; version?: string; url?: string } | null = null;
  const updatePop = el('div', { class: 'update-pop hidden' });
  document.body.append(updatePop);
  const closeUpdatePop = () => updatePop.classList.add('hidden');
  const openUpdatePop = () => {
    updatePop.innerHTML = '';
    const head = el('div', { class: 'update-pop-head' });
    head.append(el('span', { class: 'update-pop-title' }, 'Update available'));
    const x = el('button', { class: 'icon-btn', title: 'Close' }) as HTMLButtonElement;
    x.append(iconEl('x', 13));
    x.onclick = closeUpdatePop;
    head.append(x);
    updatePop.append(head);
    updatePop.append(el('p', { class: 'update-pop-text' }, `Barang ${updateInfo?.version ?? ''} is available — you have v${updateInfo?.current ?? ''}.`));
    if (updateInfo?.url) {
      const link = el('a', { class: 'btn btn-primary btn-sm', href: updateInfo.url, target: '_blank', rel: 'noreferrer' }, 'Download update');
      updatePop.append(link);
    }
    updatePop.classList.remove('hidden');
  };
  document.addEventListener('mousedown', (e) => {
    if (!updatePop.classList.contains('hidden') && !updatePop.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.update-btn')) {
      closeUpdatePop();
    }
  });
  const refreshUpdateBadge = async (manual: boolean) => {
    try {
      updateInfo = await barang().app.checkUpdates();
    } catch (e) {
      if (manual) toast(`Update check failed: ${(e as Error).message}`, 'error');
      return;
    }
    updateDot.classList.toggle('hidden', !updateInfo.update);
    btnUpdate.title = updateInfo.update ? `Update available: ${updateInfo.version}` : 'Check for updates';
    if (manual) {
      if (updateInfo.update) openUpdatePop();
      else toast(`You're on the latest version (v${updateInfo.current}).`, 'info');
    }
  };
  btnUpdate.onclick = () => {
    if (updateInfo?.update) openUpdatePop();
    else void refreshUpdateBadge(true);
  };
  // Boot check in the background — never blocks startup.
  void refreshUpdateBadge(false);
  const openFolderFlow = async () => {
    try {
      if (!(await closeAllTabs())) return; // user kept unsaved work — abort the switch
      const res = await barang().app.openFolder().catch((e) => {
        if (/cancelled/i.test((e as Error).message)) return null;
        throw e;
      });
      if (!res) return; // dialog cancelled — nothing closed, nothing switched
      await switchRoot(res.root);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const openPathFlow = async (path: string) => {
    try {
      if (!(await closeAllTabs())) return;
      const res = await barang().app.openPath(path);
      await switchRoot(res.root);
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
  const boltHost = el('div', { class: 'bolt-host hidden', id: 'bolt-host' });
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
        <div><kbd>Ctrl+N</kbd><span>new untitled tab</span></div>
        <div><kbd>Ctrl+W</kbd><span>close tab</span></div>
        <div><kbd>Ctrl+\`</kbd><span>terminal</span></div>
        <div><kbd>Ctrl+Shift+\`</kbd><span>new terminal</span></div>
        <div><kbd>Ctrl+Shift+G</kbd><span>source control</span></div>
        <div><kbd>Ctrl+Shift+E</kbd><span>explorer</span></div>
        <div><kbd>Ctrl+J</kbd><span>agent panel</span></div>
      </div>
    </div>`;
  (welcome.querySelector('.welcome-logo') as HTMLElement).append(logoImg(52));
  center.append(tabs, editorHost, boltHost, welcome);

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
    for (const r of recents.slice(0, 3)) {
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
    if (!root) {
      toast('Open a folder to browse files.', 'info');
      return;
    }
    setSideRail(!sidebar.classList.contains('rail'));
  };
  railBtn.onclick = () => setSideRail(false);
  const statusbar = el('div', { class: 'statusbar' });
  const termPanel = el('div', { id: 'term-panel' });
  const toasts = el('div', { id: 'toasts' });
  app.append(topbar, main, termPanel, statusbar, toasts);

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
    // The CLI ships inside Barang (vendor/opencode) — this banner means the
    // bundled server failed to start (slow first boot, AV lock), not that
    // anything needs installing. It hides itself on opencode:ready.
    ocBanner.append(
      iconEl('alert', 14),
      el('span', {}, 'Agent offline — the bundled opencode failed to start. Editing still works.'),
    );
    const btnRetryOc = el('button', { class: 'btn btn-sm' }, 'Retry') as HTMLButtonElement;
    btnRetryOc.onclick = () => {
      btnRetryOc.toggleAttribute('disabled', true);
      btnRetryOc.textContent = 'Retrying…';
      void barang().app.retryOpencode()
        .catch((e) => {
          btnRetryOc.toggleAttribute('disabled', false);
          btnRetryOc.textContent = 'Retry';
          toast(`Agent still offline: ${(e as Error).message}`, 'error');
        });
      // Success path: opencode:ready broadcast hides this banner.
    };
    ocBanner.append(btnRetryOc);
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

  const status = initStatusbar(statusbar, { root, opencodeVersion, opencodeOk }, {
    onToggleTerminal: () => termApi.toggle(),
    // VSCode parity: the statusbar branch opens the branch picker directly.
    onOpenScm: (x, y) => {
      setSideView('scm');
      void scmApi.openBranchMenu(x, y);
    },
  });

  // Integrated terminal (bottom panel). Statusbar toggle lives next to agent-idle.
  const termApi: TerminalApi = initTerminal(termPanel, { toast });
  termApi.onChange(({ count, open }) => status.setTerminal(count, open));

  // Bolt API client (declared early: paintTabs routes bolt tabs through it).
  let boltApi: BoltApi | null = null;

  const paintTabs = () => {
    const { tabs: ts, active } = editorStore.get();
    tabs.innerHTML = '';
    // Welcome (shortcuts + recents) is an empty-state screen only: hidden
    // once any tab is open OR a project is loaded.
    welcome.classList.toggle('hidden', ts.length > 0 || root !== '');
    const activeIsBolt = !!active?.startsWith('bolt:');
    editorHost.classList.toggle('hidden', ts.length === 0 || activeIsBolt);
    boltHost.classList.toggle('hidden', !activeIsBolt);
    for (const t of ts) {
      const isBolt = t.path.startsWith('bolt:');
      const file = t.file ?? t.path;
      const name = isBolt
        ? (boltApi?.tabName(t.path.slice(5)) ?? 'Request')
        : (t.title ?? file.split('/').pop() ?? file);
      const isDiff = !!t.diff;
      const b = el('button', {
        class: `tab${t.path === active ? ' active' : ''}${isDiff ? ' is-diff' : ''}`,
        title: isBolt ? `Bolt request — ${name}` : isDiff ? `${file} — session changes (read-only review)` : t.path,
        'data-path': t.path,
      }) as HTMLButtonElement;
      if (isDiff) b.append(el('span', { class: 'diff-badge' }, 'changes'));
      if (isBolt) b.append(iconEl('bolt', 14));
      else b.append(fileIconEl(isDiff ? (t.file ?? '') : name, 14));
      b.append(el('span', { class: 'tab-name' }, name));
      if (t.dirty) b.append(el('span', { class: 'dirty-dot', title: 'Unsaved changes' }));
      b.onclick = () => {
        if (isBolt) boltApi?.activate(t.path.slice(5));
        else if (t.diff) showDiffTab(t.path);
        else void openFile(t.path);
      };
      b.onauxclick = (e) => {
        if (e.button === 1) void closeTab(t.path);
      };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = t.path;
        const f = t.file ?? t.path;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Close', icon: 'x', run: () => void closeTab(p) },
          { label: 'Close Others', icon: 'x', run: () => void closeOtherTabs(p) },
          { label: 'Close Saved', icon: 'check', run: () => closeSavedTabs() },
          { label: 'Close All', icon: 'x', run: () => void closeAllTabs() },
          ...(isBolt ? [] : [
            { sep: true as const },
            {
              label: 'Copy Path', icon: 'file' as const,
              run: () => void copyText(f).then((ok) => toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')),
            },
            { label: 'Reveal in Explorer', icon: 'folder' as const, run: () => void revealInTree(f) },
          ]),
        ]);
      };
      const x = el('span', { class: 'tab-x', title: 'Close' });
      x.append(iconEl('x', 12));
      x.onclick = (e) => {
        e.stopPropagation();
        void closeTab(t.path);
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

  const explorerHooks = {
    onOpenFile: (p: string, opts?: { focus?: boolean }) => void openFile(p, opts),
    onOpenFolder: () => void openFolderFlow(),
    onCollapseSidebar: () => setSideRail(true),
    onPathRenamed: (from: string, to: string) => {
      // A renamed file moves its tab along (dirty tab asks first);
      // a renamed folder closes orphaned child tabs (one confirm if dirty).
      void (async () => {
        if (editorStore.get().tabs.some((t) => t.path === from)) {
          await closeTab(from);
          await closePathAndChildren(`diff:${from}`); // drop its stale review tab too
          if (!editorStore.get().tabs.some((t) => t.path === from)) void openFile(to);
        } else {
          await closePathAndChildren(from);
        }
        refreshExplorer();
        explorer.repaint();
      })();
    },
    onPathRemoved: (p: string) => {
      clearFocusedEntry(p);
      void (async () => {
        try {
          if (!(await closePathAndChildren(p))) return; // user cancelled (dirty tabs)
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
    gitStatusOf: (p: string) => decoration(p, false),
    onSearchInFolder: (p: string) => {
      setSideView('search');
      searchApi?.setScope(p === '.' ? '' : p);
    },
  };

  // Sidebar views: Explorer | Source Control | Bolt | Search.
  const viewBar = el('div', { class: 'side-viewbar' });
  const btnViewExplorer = el('button', { class: 'icon-btn side-view-btn active', title: 'Explorer (Ctrl+Shift+E)' }) as HTMLButtonElement;
  btnViewExplorer.append(iconEl('folder', 15));
  const btnViewScm = el('button', { class: 'icon-btn side-view-btn', title: 'Source control (Ctrl+Shift+G)' }) as HTMLButtonElement;
  btnViewScm.append(iconEl('branch', 15));
  const scmBadge = el('span', { class: 'scm-badge hidden' });
  btnViewScm.append(scmBadge);
  const btnViewApi = el('button', { class: 'icon-btn side-view-btn', title: 'Bolt — API client' }) as HTMLButtonElement;
  btnViewApi.append(iconEl('bolt', 15));
  const btnViewSearch = el('button', { class: 'icon-btn side-view-btn', title: 'Search (Ctrl+Shift+F)' }) as HTMLButtonElement;
  btnViewSearch.append(iconEl('search', 15));
  viewBar.append(btnViewExplorer, btnViewScm, btnViewApi, btnViewSearch);
  const explorerHost = el('div', { class: 'side-view', id: 'view-explorer' });
  const scmHost = el('div', { class: 'side-view hidden', id: 'view-scm' });
  const apiHost = el('div', { class: 'side-view hidden', id: 'view-api' });
  const searchHost = el('div', { class: 'side-view hidden', id: 'view-search' });
  type SideView = 'explorer' | 'scm' | 'api' | 'search';
  let searchApi: SearchApi | null = null;
  const setSideView = (v: SideView) => {
    explorerHost.classList.toggle('hidden', v !== 'explorer');
    scmHost.classList.toggle('hidden', v !== 'scm');
    apiHost.classList.toggle('hidden', v !== 'api');
    searchHost.classList.toggle('hidden', v !== 'search');
    btnViewExplorer.classList.toggle('active', v === 'explorer');
    btnViewScm.classList.toggle('active', v === 'scm');
    btnViewApi.classList.toggle('active', v === 'api');
    btnViewSearch.classList.toggle('active', v === 'search');
    try {
      localStorage.setItem('barang:side-view', v);
    } catch { /* private mode */ }
    if (v === 'scm') void scmApi.refresh();
    if (v === 'search') searchApi?.focus();
  };
  btnViewExplorer.onclick = () => setSideView('explorer');
  btnViewScm.onclick = () => setSideView('scm');
  btnViewApi.onclick = () => setSideView('api');
  btnViewSearch.onclick = () => setSideView('search');
  const buildSideViews = () => {
    // Hosts persist across switches (view state lives on them) — clear their
    // painted content so re-init never stacks duplicate headers/trees.
    explorerHost.innerHTML = '';
    sidebar.innerHTML = '';
    sidebar.append(railBtn, viewBar, explorerHost, scmHost, apiHost, searchHost);
  };
  buildSideViews();

  let explorer = initExplorer(explorerHost, explorerHooks, root);
  const scmApi: ScmApi = initScm(scmHost, {
    toast,
    onOpenFile: (p, opts) => void openFile(p, opts),
    revealInExplorer: (p) => void revealInTree(p),
    refreshExplorer: () => {
      refreshExplorer();
      explorer.repaint();
    },
    onRepo: (info) => {
      status.setGit(info);
      const n = info?.total ?? 0;
      scmBadge.textContent = n > 99 ? '99+' : String(n);
      scmBadge.classList.toggle('hidden', n === 0);
    },
  });
  try {
    const v = localStorage.getItem('barang:side-view');
    if (v === 'scm' || v === 'api' || v === 'search') setSideView(v as SideView);
  } catch { /* fresh default */ }

  // Sidebar Search view (project find + replace).
  searchApi = initSearchView(searchHost, {
    toast,
    revealInEditor: (p, line) => void revealInEditor(p, line),
    refreshExplorer: () => {
      refreshExplorer();
      explorer.repaint();
    },
  });

  // Bolt API client (sidebar collections + center request tabs). Tab-strip
  // repaints flow through the editorStore subscription (every bolt mutation
  // already goes through editorStore.set), so onTabs is a noop.
  boltApi = initBolt(apiHost, { toast, onTabs: () => undefined });

  // Hot project switch: no page reload (Monaco stays warm, no bundle
  // re-parse). Explorer re-inits, tabs reset, sessions reload scoped.
  let currentRoot = root;
  async function switchRoot(newRoot: string) {
    currentRoot = newRoot;
    root = newRoot;
    agentStore.set({
      root: newRoot, sessions: [], activeId: null, messages: [],
      permissions: [], busy: false, status: 'connecting', error: null,
    });
    status.setRoot(newRoot);
    sidebar.classList.remove('collapsed');
    agentPanel.classList.remove('collapsed');
    buildSideViews();
    resetExplorerState();
    explorer = initExplorer(explorerHost, explorerHooks, newRoot);
    void scmApi.refresh();
    try {
      const st = await appState();
      appRecents = st.recent ?? [];
      paintWelcome(appRecents);
    } catch { /* recents stay as-is */ }
    await loadSessions().catch((e) => toast(`Sessions: ${(e as Error).message}`, 'error'));
    void ensureSession();
  }

  initChat(agentPanel, { toast });
  connectEvents();
  // First-run UX: with a project open and the agent online but zero
  // sessions, boot straight into a fresh session — never strand the user
  // on an empty skeletal panel waiting for them to find the + button.
  // Silent by design: polls for the server (folder switches restart it),
  // and the offline banner + error toast own genuine failures — this toast
  // must only ever fire when a session was actually expected and possible.
  let creatingSession = false;
  async function ensureSession() {
    if (!root) return;
    for (let i = 0; i < 6; i++) {
      try {
        if ((await appState()).opencode.running) break;
      } catch {
        /* backend hiccup — retry below */
      }
      await new Promise((r) => setTimeout(r, 2000));
      if (i === 5) return; // still down: banner + error path own the message
    }
    if (creatingSession) return;
    try {
      await loadSessions();
    } catch {
      return;
    }
    const s = agentStore.get();
    if (!shouldAutoCreateSession(root, true, s.sessions.length, creatingSession)) return;
    creatingSession = true;
    try {
      await createSession();
    } catch {
      /* silent: banner + error broadcast cover real outages */
    } finally {
      creatingSession = false;
    }
  }
  void ensureSession();
  // Agent notifications: Windows toast + taskbar badge + sound when a run
  // finishes, needs approval, or errors. Renderer decides, main toasts.
  armAudioUnlock();
  watchAgentNotifications((kind: NotifyKind) => {
    const s = readSettings();
    if (!s.notifEnabled) return;
    if (kind === 'done' && !s.notifOnDone) return;
    if (kind === 'approval' && !s.notifOnApproval) return;
    if (kind === 'error' && !s.notifOnError) return;
    const title = agentStore.get().error && kind === 'error'
      ? 'Barang — agent error'
      : kind === 'approval' ? 'Barang — approval needed' : 'Barang — agent finished';
    const body = kind === 'error'
      ? (agentStore.get().error ?? 'The run failed.').slice(0, 200)
    : kind === 'approval'
      ? (() => {
        const bits: string[] = [];
        if (agentStore.get().permissions.length) bits.push(`${agentStore.get().permissions.length} approval(s)`);
        if (agentStore.get().questions.length) bits.push(`${agentStore.get().questions.length} question(s)`);
        return `${bits.join(' + ') || 'Something'} waiting for your review.`;
      })()
        : (activeSessionTitle() ?? 'Your task is complete.');
    if (s.notifSound) {
      const url = resolveSoundUrl(kind === 'error' ? 'alert' : s.notifSoundName, s.notifCustomPath);
      void playNotificationSound(url, s.notifVolume / 100);
    }
    const focused = document.hasFocus();
    if (!focused && s.notifNative) {
      void barang().app.notify({ title, body, kind, badge: s.notifTaskbar }).catch(() => undefined);
    } else if (focused && s.notifToastFocused) {
      toast(`${title.replace('Barang — ', '')}: ${body}`, kind === 'error' ? 'error' : 'info');
    }
  });
  // Smoke/introspection hook (read-only decision fn, like __barangTermBuffer).
  (window as unknown as { __barangNotifDecide: typeof decideAgentNotification }).__barangNotifDecide = decideAgentNotification;
  // Perf-cap introspection: pure helpers + decisions (unit-probed in smoke).
  (window as unknown as { __barangTestUtils: unknown }).__barangTestUtils = {
    sliceWindow,
    truncateText,
    shouldAutoCreateSession,
    pickDefaultModel,
    substituteVars,
    buildUrl,
    parseUrlParams,
    prettyBody,
    highlightJson,
    headerValueSuggestions,
    COMMON_HEADER_NAMES,
    fmtTokens,
    sessionUsage,
    highlightLine,
    isRetryableSendError,
    withSendRetries,
    sanitizeOutgoingFiles,
    resolveSendModel,
    statusTextFor,
    messageErrorText,
    decideStalled,
    permissionFromEvent,
    parseAgentEvent,
    isTransportDown,
    findUserMessage,
    todoProgress,
    questionFromEvent,
    describeActivity,
    decideStatus,
    shortenMiddle,
    classifyAttachFile,
  };
  // Model/agent catalog + free-model defaults (Muse Spark when available).
  void loadMeta().catch((e) => toast(`opencode metadata: ${e.message}`, 'error'));

  const toggleAgent = () => {
    if (!root) {
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
    toggleTerminalPanel: () => termApi.toggle(),
    terminalNew: () => termApi.newTerminal(true),
    terminalClear: () => termApi.clearActive(),
    terminalKill: () => termApi.killActive(),
    showView: (v) => setSideView(v),
    boltNew: () => {
      setSideView('api');
      boltApi?.newRequest(true);
    },
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
  // root-changed arrives for externally-triggered switches; our own flows
  // hot-switch directly. opencode:ready/error track the background server.
  try {
    barang().app.onMenu((kind, payload) => {
      if (kind === 'root-changed') {
        const r = (payload as { root?: string } | undefined)?.root;
        if (r && r !== currentRoot) void switchRoot(r);
      } else if (kind === 'opencode:ready') {
        void (async () => {
          try {
            const st = await appState();
            opencodeOk = st.opencode.running;
            status.setOpencode(st.opencode.running, st.opencode.version ?? st.opencode.cli ?? null);
            ocBanner.classList.add('hidden'); // background boot landed — drop the offline banner
            await loadSessions();
            // Provider-gated defaults (spark/mimo) can only resolve now —
            // boot-time loadMeta raced the server and saw an empty catalog.
            await loadMeta().catch(() => {});
            toast('Agent connected.', 'info');
            void ensureSession();
          } catch (e) {
            toast(`Agent state: ${(e as Error).message}`, 'error');
          }
        })();
      } else if (kind === 'opencode:error') {
        const msg = (payload as { error?: string } | undefined)?.error || 'Agent failed to start';
        opencodeOk = false;
        status.setOpencode(false, null);
        toast(`Agent offline: ${msg}`, 'error');
      }
    });
  } catch (e) {
    toast((e as Error).message, 'error');
  }

  // --- keybindings (VSCode-style) ----------------------------------------
  // Text-entry targets (inputs, Monaco, palette, menus, terminal) keep their keys.
  const isTypingTarget = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && !!a.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .monaco-menu, .xterm');
  };
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // A focused shell owns its keys (VSCode): workbench file ops stay out,
    // palette + terminal chords still work.
    const termFocus = termApi.hasFocus();
    if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open('');
    } else if (mod && e.key.toLowerCase() === 'p' && e.shiftKey) {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open('> ');
    } else if (mod && e.key.toLowerCase() === 'f' && e.shiftKey) {
      e.preventDefault();
      setSideView('search');
    } else if (mod && e.key.toLowerCase() === 's' && !termFocus) {
      e.preventDefault();
      if (e.shiftKey) {
        void saveAll();
      } else {
        const active = editorStore.get().active;
        if (active?.startsWith('bolt:')) {
          // Bolt request tabs save into their collection, not to disk.
          if (boltApi?.saveActiveTab()) toast('Saved', 'info');
        } else {
          void saveActive().then((ok) => {
            if (ok) toast('Saved', 'info');
          });
        }
      }
    } else if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey && !termFocus) {
      e.preventDefault();
      openUntitled();
    } else if (mod && e.key.toLowerCase() === 'w' && !e.shiftKey && !termFocus) {
      e.preventDefault();
      const active = editorStore.get().active;
      if (active) void closeTab(active);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !isTypingTarget()) {
      e.preventDefault();
      deleteFocusedEntry();
    } else if (mod && e.key.toLowerCase() === 'b' && !termFocus) {
      e.preventDefault();
      toggleSideRail();
    } else if (mod && e.key.toLowerCase() === 'e' && e.shiftKey) {
      e.preventDefault();
      setSideView('explorer');
    } else if (mod && e.key.toLowerCase() === 'o' && !termFocus) {
      e.preventDefault();
      openFolderFlow();
    } else if (mod && e.key.toLowerCase() === 'g' && e.shiftKey) {
      // VSCode SCM focus: reveal the Source Control view + commit box.
      e.preventDefault();
      setSideView('scm');
      scmApi.focusCommit();
    } else if (mod && e.code === 'Backquote') {
      // VSCode terminal chords: Ctrl+` toggle panel, Ctrl+Shift+` new terminal.
      e.preventDefault();
      if (e.shiftKey) termApi.newTerminal(true);
      else termApi.toggle();
    } else if (mod && e.key.toLowerCase() === 'j' && !e.shiftKey) {
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
    void scmApi.refresh();
  });

  // Keep the "agent changed files" loop tight while busy too. Debounced:
  // every message part would otherwise trigger a full tree repaint + stat
  // roundtrip mid-stream.
  const syncOnIdle = debounce(() => {
    if (!agentStore.get().busy) {
      void checkExternalChanges();
      refreshExplorer();
      explorer.repaint();
    }
  }, 400);
  agentStore.subscribe(syncOnIdle);

  if (opencodeOk) toast(`Connected to opencode ${opencodeVersion ?? ''} — agent online`, 'info');
}

boot().catch((e) => {
  document.getElementById('app')!.innerHTML =
    `<div style="padding:32px;font-family:system-ui">Failed to start Barang: ${String(e?.message || e)}</div>`;
  console.error(e);
});
