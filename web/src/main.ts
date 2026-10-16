// Barang shell: layout, wiring, keybindings. Framework-free on purpose:
// the whole interactive shell (minus editor + agent logic) is this file.
import './styles.css';
import { appState } from './lib/api';
import { barang } from './lib/transport';
import { connectEvents, agentStore, createSession, selectSession, loadMeta, loadSessions, readSettings, shouldAutoCreateSession, pickDefaultModel, fmtTokens, sessionUsage, isRetryableSendError, withSendRetries, sanitizeOutgoingFiles, resolveSendModel, statusTextFor, messageErrorText, decideStalled,   permissionFromEvent, parseAgentEvent, isTransportDown, findUserMessage, todoProgress,
  questionFromEvent, describeActivity, decideStatus, shortenMiddle, classifyAttachFile, usageCard,
resolveSendVariant, loadCommands, parseSlashCommand, isRepeatAsk, pruneQuestions, upsertQuestion, removeQuestion,
upsertPermission, removePermission, markPermissionAnswered, clearSessionPermissions, isPermissionStaleError,
pruneAnsweredKeys, enqueueFollowUp, queuedFollowUps, dequeueFollowUp, removeQueuedFollowUp, clearQueuedFollowUps, drainQueue, deriveSessionChanges, normalizeNotifSoundSettings, quietNextStop, consumeQuietStop, isFreeTierGateError, freeTierGuidance, isModelAccessError, modelAccessGuidance, relayActive, relayRouteFor, modelListKey, derivePromptTitle, isUntitledSessionTitle, sessionDisplayTitle, decideRelayStuck, stuckContinueText, normEchoText, findUserMessageLoose, relayEchoGuard, isTransientRelayEcho } from './lib/agent';
import {
  shouldRelayRoute, buildRelayArgs, parseRelayLine, relayProgressLabel, redactSecrets, RELAY_DISPLAY_NAME,
} from './lib/relay';
import {
  validateProviderEntry, parseModelIds, normalizeProviderKey, providerToLiveConfig,
  setProviderEntry, removeProviderEntry, listProviderEntries,
} from './lib/providers';
import { sliceWindow, truncateText, parseUnifiedPatch, applyHunkSubset, tabPageRange } from './lib/util';
import { watchAgentNotifications, playNotificationSound, resolveKindSound, KIND_DEFAULT_SOUND, debugAudioState, activeSessionTitle, decideAgentNotification, armAudioUnlock, type NotifyKind } from './lib/notify';
import { el, debounce, copyText } from './lib/util';
import { iconEl } from './ui/icons';
import { fileIconEl } from './ui/fileIcons';
import { openSettings } from './ui/settings';
import { confirmDialog } from './ui/dialog';
import logoUrl from './assets/barang-logo.png';

function logoImg(size: number, cls = ''): HTMLImageElement {
  const img = el('img', { class: `brand-logo ${cls}`.trim(), src: logoUrl, alt: 'Barang logo', width: String(size), height: String(size) }) as HTMLImageElement;
  return img;
}
import { initExplorer, refreshExplorer, revealInTree, resetExplorerState, clearFocusedEntry,
deleteFocusedEntry, pathOf } from './ui/explorer';
import { initEditor, openFile, openUntitled, showDiffTab, closeTab, closeOtherTabs, closeAllTabs, closeSavedTabs, closePathAndChildren, saveActive, saveAll, checkExternalChanges, editorStore, revealInEditor,
revealSearchMatch, clearSearchDecorations, getSearchDecorCount, langOf, getTsDiagOptions, registeredLanguageIds,
parseTsconfigPaths, matchAlias, packageNameOf, candidateImportPaths, specResolves, toggleSplit, focusGroup,
openInOtherGroup, closeSplitGroup, setSplitHost, groupTabs, editorSplitState, openPreview, showPreviewTab,
showImageTab, getEditorDisplayFlags, isAbsolutePath, flushTabSession, restoreTabSession, debugModelText, debugDisplayedText, setFileOpenedHandler } from './ui/editor';
import { initChat, filePartView, stepHistory, pushComposerHist, changeFp, isReviewed, markReviewed, loadReviewedState, scheduleReviewedPersist, openLightbox, closeLightbox } from './ui/chat';
import { initPalette } from './ui/palette';
import { initPomodoro, pomoDotsFilled } from './ui/pomodoro';
import { pomoNext, formatClock, normalizePomoSettings, POMO_DEFAULTS } from './lib/pomodoro';
import {
  parseMcpFile, toServerList, buildFileText, validateServer, parseKvLines,
  toLiveConfig, wordpressQuickFill, wordpressEndpoint, mergeStatuses,
} from './lib/mcp';
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
  const btnIDE = el('button', { class: 'top-btn hidden', title: 'Back to editor (IDE)' }) as HTMLButtonElement;
  btnIDE.append(iconEl('file', 14), el('span', {}, 'IDE'));
  btnIDE.onclick = () => exitAgentic();
  const btnVibe = el('button', { class: 'top-btn hidden', title: 'Vibe with the agent — no editor' }) as HTMLButtonElement;
  btnVibe.append(iconEl('spark', 14), el('span', {}, 'Vibe'));
  btnVibe.onclick = () => void enterAgenticFlow();
  const btnSettings = el('button', { class: 'top-btn settings-btn', title: 'Settings' }) as HTMLButtonElement;
  btnSettings.append(iconEl('gear', 15));
  const btnUpdate = el('button', { class: 'top-btn update-btn hidden', title: 'Check for updates' }) as HTMLButtonElement;
  btnUpdate.append(iconEl('download', 14));
  topActions.append(openSplit, btnPalette, btnAgent, btnVibe, btnIDE, btnSettings, btnUpdate);

  // Self-updater: the button exists only while a newer release is known.
  // Click downloads the portable and restarts into it (dev builds open the
  // release page instead — nothing to restart into). Silent when offline.
  type UpdateState = { update: boolean; current: string; version?: string; url?: string; packaged?: boolean; error?: string; replaceTarget?: string | null };
  let updateInfo: UpdateState | null = null;
  let updatePhase: 'idle' | 'downloading' | 'ready' | 'error' = 'idle';
  let updatePath = '';
  let updateReplace = true; // replace my original exe (when discoverable)
  let updateProgress = { received: 0, total: 0 };
  let updateError = '';
  const updatePop = el('div', { class: 'update-pop hidden' });
  document.body.append(updatePop);
  const closeUpdatePop = () => updatePop.classList.add('hidden');
  const fmtMB = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
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
    if (updateInfo && !updateInfo.packaged && updateInfo.url) {
      const link = el('a', { class: 'btn btn-primary btn-sm', href: updateInfo.url, target: '_blank', rel: 'noreferrer' }, 'Open release page');
      updatePop.append(link);
    } else if (updatePhase === 'downloading') {
      const pct = updateProgress.total > 0 ? Math.floor((updateProgress.received / updateProgress.total) * 100) : 0;
      updatePop.append(el('p', { class: 'update-pop-text' }, `Downloading… ${pct}%${updateProgress.total > 0 ? ` of ${fmtMB(updateProgress.total)}` : ''}`));
      const track = el('div', { class: 'update-bar' });
      const fill = el('div', { class: 'update-fill' });
      fill.style.width = `${pct}%`;
      track.append(fill);
      updatePop.append(track);
    } else if (updatePhase === 'ready') {
      const go = el('button', { class: 'btn btn-primary btn-sm' }, `Restart into ${updateInfo?.version ?? ''}`) as HTMLButtonElement;
      go.onclick = () => void applyUpdateFlow();
      updatePop.append(go);
      // Replace-my-original: copy the download over the launched exe once
      // it quits (otherwise the old file keeps asking for updates forever).
      if (updateInfo?.replaceTarget) {
        const row = el('label', { class: 'update-replace' });
        const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
        box.checked = updateReplace;
        box.onchange = () => {
          updateReplace = box.checked;
        };
        const name = updateInfo.replaceTarget.split(/[\\/]/).pop() ?? updateInfo.replaceTarget;
        row.append(box, el('span', { title: updateInfo.replaceTarget }, `Replace ${name}`));
        updatePop.append(row);
      }
    } else if (updatePhase === 'error') {
      updatePop.append(el('p', { class: 'update-pop-text' }, `Download failed: ${updateError}`));
      const retry = el('button', { class: 'btn btn-sm' }, 'Try again') as HTMLButtonElement;
      retry.onclick = () => void downloadUpdateFlow();
      updatePop.append(retry);
    } else {
      const dl = el('button', { class: 'btn btn-primary btn-sm' }, `Download & restart`) as HTMLButtonElement;
      dl.onclick = () => void downloadUpdateFlow();
      updatePop.append(dl);
    }
    updatePop.classList.remove('hidden');
  };
  document.addEventListener('mousedown', (e) => {
    if (!updatePop.classList.contains('hidden') && !updatePop.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.update-btn')) {
      closeUpdatePop();
    }
  });
  const downloadUpdateFlow = async () => {
    updatePhase = 'downloading';
    updateProgress = { received: 0, total: 0 };
    openUpdatePop();
    try {
      const res = await barang().app.downloadUpdate();
      updatePath = res.path;
      updatePhase = 'ready';
    } catch (e) {
      updatePhase = 'error';
      updateError = (e as Error).message;
    }
    openUpdatePop();
  };
  barang().app.onUpdateProgress((ev) => {
    if (ev.replaced) {
      toast(`Updated in place: ${ev.replaced}`, 'info');
      void refreshUpdateBadge(true);
      return;
    }
    if (ev.replaceError) {
      toast(`Original file kept (replace failed: ${ev.replaceError}). The new version is running from the download.`, 'error');
      return;
    }
    updateProgress = { received: ev.received ?? 0, total: ev.total ?? 0 };
    if (updatePhase === 'downloading' && !updatePop.classList.contains('hidden')) openUpdatePop();
    btnUpdate.title = updateProgress.total > 0
      ? `Downloading update… ${Math.floor((updateProgress.received / updateProgress.total) * 100)}%`
      : 'Downloading update…';
  });
  const applyUpdateFlow = async () => {
    const dirty = editorStore.get().tabs.filter((t) => t.dirty).length;
    const replacing = updateReplace && updateInfo?.replaceTarget ? updateInfo.replaceTarget : '';
    const ok = await confirmDialog({
      title: `Restart into ${updateInfo?.version ?? 'the update'}?`,
      message: dirty > 0
        ? `You have ${dirty} unsaved file${dirty > 1 ? 's' : ''} — they will be lost. Save first, or continue anyway.`
        : `Barang will close and reopen as ${updateInfo?.version ?? 'the new version'}.`
        + (replacing ? `\n\nYour current file will be replaced:\n${replacing}` : ''),
      confirmLabel: 'Restart & update',
      danger: dirty > 0,
    });
    if (!ok) return;
    try {
      const res = await barang().app.applyUpdate(updatePath, replacing);
      if (!res.ok) throw new Error('restart rejected');
    } catch (e) {
      toast(`Update failed: ${(e as Error).message}`, 'error');
    }
  };
  const refreshUpdateBadge = async (manual: boolean) => {
    try {
      updateInfo = await barang().app.checkUpdates();
    } catch (e) {
      if (manual) toast(`Update check failed: ${(e as Error).message}`, 'error');
      return;
    }
    const show = !!updateInfo.update;
    btnUpdate.classList.toggle('hidden', !show);
    btnUpdate.title = updateInfo.update ? `Update available: ${updateInfo.version} — click to install` : 'Check for updates';
    if (!show) {
      updatePhase = 'idle';
      closeUpdatePop();
    }
    if (manual) {
      if (updateInfo.update) openUpdatePop();
      else if (updateInfo.error) toast(`Update check failed: ${updateInfo.error}`, 'error');
      else toast(`You're on the latest version (v${updateInfo.current}).`, 'info');
    }
  };
  btnUpdate.onclick = () => {
    if (updateInfo?.update) openUpdatePop();
    else void refreshUpdateBadge(true);
  };
  // Boot check in the background — never blocks startup; re-check hourly.
  void refreshUpdateBadge(false);
  setInterval(() => void refreshUpdateBadge(false), 3600000);
  const openFolderFlow = async () => {
    try {
      flushTabSession(); // snapshot this project before tabs close
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
      flushTabSession(); // snapshot this project before tabs close
      if (!(await closeAllTabs())) return;
      const res = await barang().app.openPath(path);
      await switchRoot(res.root);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  btnFolder.onclick = openFolderFlow;
  btnSettings.onclick = () => openSettings({ toast, onCheckUpdates: () => void refreshUpdateBadge(true) });
  const ocBanner = el('div', { class: 'oc-banner hidden' });
  topbar.append(brand, ocBanner, topActions);

  const main = el('div', { class: 'main' });
  const sidebar = el('div', { class: 'sidebar' });
  const gutterL = el('div', { class: 'gutter-v', title: 'Drag to resize · double-click to reset' });
  const center = el('div', { class: 'center' });
  const tabs = el('div', { class: 'tabs group-tabs' });
  const editorHost = el('div', { class: 'editor-host' });
  const tabs2 = el('div', { class: 'tabs group-tabs' });
  const editorHost2 = el('div', { class: 'editor-host' });
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
        <div><kbd>↑↓</kbd><span>history (empty box)</span></div>
        <div><kbd>Ctrl+S</kbd><span>save file</span></div>
        <div><kbd>Ctrl+N</kbd><span>new untitled tab</span></div>
        <div><kbd>Ctrl+W</kbd><span>close tab</span></div>
        <div><kbd>Ctrl+\`</kbd><span>terminal</span></div>
        <div><kbd>Ctrl+Shift+\`</kbd><span>new terminal</span></div>
        <div><kbd>Ctrl+Shift+G</kbd><span>source control</span></div>
        <div><kbd>Ctrl+Shift+E</kbd><span>explorer</span></div>
        <div><kbd>Ctrl+J</kbd><span>agent panel</span></div>
        <div><kbd>Ctrl+\</kbd><span>split editor</span></div>
        <div><kbd>Ctrl+1 / Ctrl+2</kbd><span>focus group</span></div>
      </div>
    </div>`;
  (welcome.querySelector('.welcome-logo') as HTMLElement).append(logoImg(52));
  // Editor groups (VSCode split): each column owns a tab strip + pane.
  // Bolt/welcome stay center-wide overlays above the columns.
  const col1 = el('div', { class: 'editor-col' });
  col1.append(tabs, editorHost);
  const splitCol = el('div', { class: 'editor-col split-col hidden' });
  splitCol.append(tabs2, editorHost2);
  const editorCols = el('div', { class: 'editor-cols' });
  editorCols.append(col1, splitCol);
  center.append(editorCols, boltHost, welcome);
  setSplitHost(editorHost2);

  // OS file drop: absolute paths open straight through openFile (in-project
  // ones become workspace tabs, the rest detached tabs); folders open as the
  // project — VSCode behavior. Drops on the chat composer keep their
  // attachment flow (the composer owns those events).
  const dropPaths = async (paths: string[], group: 1 | 2 = 1) => {
    const list = (paths ?? []).map((p) => String(p || '')).filter(Boolean).slice(0, 20);
    if (!list.length) return;
    const abs = list.filter(isAbsolutePath);
    const rel = list.filter((p) => !isAbsolutePath(p));
    let stats: Array<{ path: string; exists: boolean; isDir: boolean }> = [];
    if (abs.length) {
      try {
        stats = await barang().fs.statPaths(abs);
      } catch {
        stats = abs.map((p) => ({ path: p, exists: false, isDir: false }));
      }
    }
    const dirs = stats.filter((s) => s.exists && s.isDir).map((s) => s.path);
    if (dirs.length) {
      await openPathFlow(dirs[0]); // folders win, like VSCode
      return;
    }
    for (const s of stats) {
      if (!s.exists || s.isDir) continue;
      await openFile(s.path, { group }); // toasts on failure
    }
    for (const f of rel) await openFile(f, { group });
    const gone = stats.filter((s) => !s.exists).length;
    if (gone) toast(`${gone} dropped file(s) no longer exist.`, 'error');
  };
  const droppedPaths = async (e: DragEvent): Promise<string[]> => {
    const out: string[] = [];
    const dt = e.dataTransfer;
    if (!dt) return out;
    const files = [...(dt.files ?? [])] as Array<File & { path?: string }>;
    // Folders don't always surface in .files — also try the items list.
    if (!files.length && dt.items) {
      for (const it of [...dt.items]) {
        try {
          const f = it.getAsFile?.();
          if (f) files.push(f as File & { path?: string });
        } catch { /* ignore */ }
      }
    }
    for (const f of files.slice(0, 20)) {
      if (f.path) { out.push(f.path); continue; }
      // Chromium Files carry no path; the preload resolves it in Node
      // context (webUtils.getPathForFile).
      try {
        const p = barang().fs.pathForFile(f);
        if (p) out.push(p);
      } catch { /* virtual file (archive member etc.) — skip */ }
    }
    return out;
  };
  const hasDroppedFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const inComposer = (t: EventTarget | null) =>
    (t as HTMLElement | null)?.closest?.('.composer') != null;
  let centerDrag = 0;
  // Capture phase: Monaco's own drop handling must never swallow OS file
  // drops before they reach us.
  center.addEventListener('dragenter', (e) => {
    if (!hasDroppedFiles(e as DragEvent)) return;
    e.preventDefault();
    if (inComposer(e.target)) {
      center.querySelectorAll('.editor-col.drop-over').forEach((n) => n.classList.remove('drop-over'));
      return;
    }
    centerDrag++;
    const col = (e.target as HTMLElement).closest?.('.editor-col');
    center.querySelectorAll('.editor-col.drop-over').forEach((n) => {
      if (n !== col) n.classList.remove('drop-over');
    });
    col?.classList.add('drop-over');
  }, true);
  center.addEventListener('dragover', (e) => {
    if (hasDroppedFiles(e as DragEvent)) e.preventDefault();
  }, true);
  center.addEventListener('dragleave', () => {
    centerDrag = Math.max(0, centerDrag - 1);
    if (!centerDrag) {
      center.querySelectorAll('.editor-col.drop-over').forEach((n) => n.classList.remove('drop-over'));
    }
  }, true);
  center.addEventListener('drop', (e) => {
    centerDrag = 0;
    center.querySelectorAll('.editor-col.drop-over').forEach((n) => n.classList.remove('drop-over'));
    if (inComposer(e.target)) return; // chat composer attach flow handles it
    e.preventDefault();
    const group = (e.target as HTMLElement).closest?.('.split-col') ? 2 : 1;
    void droppedPaths(e as DragEvent).then((paths) => {
      if (!paths.length) return;
      void dropPaths(paths, group as 1 | 2);
    });
  }, true);

  // Welcome extras: open entry points + recent projects (from app state below
  // once loaded — painted by paintWelcome()).
  const welcomeActions = el('div', { class: 'welcome-actions' });
  const btnWelcomeOpen = el('button', { class: 'btn btn-primary' }, 'Open folder') as HTMLButtonElement;
  btnWelcomeOpen.prepend(iconEl('folder', 14));
  btnWelcomeOpen.onclick = openFolderFlow;
  const btnWelcomeAgentic = el('button', { class: 'btn', title: 'Vibe with the agent, opencode-style — no editor' }) as HTMLButtonElement;
  btnWelcomeAgentic.prepend(iconEl('spark', 14));
  btnWelcomeAgentic.append('Vibe');
  btnWelcomeAgentic.onclick = () => void enterAgenticFlow();
  welcomeActions.append(btnWelcomeOpen, btnWelcomeAgentic);
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
    onOpenPomo: () => setSideView('pomo'),
  });

  // Integrated terminal (bottom panel). Statusbar toggle lives next to agent-idle.
  const termApi: TerminalApi = initTerminal(termPanel, { toast });
  termApi.onChange(({ count, open }) => status.setTerminal(count, open));

  // Bolt API client (declared early: paintTabs routes bolt tabs through it).
  let boltApi: BoltApi | null = null;

  const activateTab = (path: string, group: 1 | 2) => {
    const t = editorStore.get().tabs.find((x) => x.path === path && (x.group || 1) === group);
    if (!t) return;
    if (t.path.startsWith('bolt:')) boltApi?.activate(t.path.slice(5));
    else if (t.diff) showDiffTab(t.path, group);
    else if (t.preview && t.file) showPreviewTab(t.path, group);
    else if (t.image) showImageTab(t.path, group);
    else void openFile(t.path, { group });
  };

  const paintStrip = (host: HTMLElement, group: 1 | 2, isFocused: boolean) => {
    host.innerHTML = '';
    host.classList.toggle('group-focus', isFocused);
    const ts = groupTabs(editorStore.get().tabs, group);
    for (const t of ts) {
      const isBolt = t.path.startsWith('bolt:');
      const file = t.file ?? t.path;
      const name = isBolt
        ? (boltApi?.tabName(t.path.slice(5)) ?? 'Request')
        : (t.title ?? file.split('/').pop() ?? file);
      const isDiff = !!t.diff;
      const b = el('button', {
        class: `tab${t.path === (group === 2 ? editorStore.get().active2 : editorStore.get().active) ? ' active' : ''}${isDiff ? ' is-diff' : ''}`,
        title: isBolt ? `Bolt request — ${name}` : isDiff ? `${file} — session changes (read-only review)` : t.path,
        'data-path': t.path,
      }) as HTMLButtonElement;
      if (isDiff) b.append(el('span', { class: 'diff-badge' }, 'changes'));
      if (isBolt) b.append(iconEl('bolt', 14));
      else b.append(fileIconEl(isDiff ? (t.file ?? '') : name, 14));
      b.append(el('span', { class: 'tab-name' }, name));
      if (t.dirty) b.append(el('span', { class: 'dirty-dot', title: 'Unsaved changes' }));
      b.onclick = () => activateTab(t.path, group);
      b.onauxclick = (e) => {
        if (e.button === 1) void closeTab(t.path, group);
      };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = t.path;
        const f = t.file ?? t.path;
        const splitOpen = editorStore.get().split;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Close', icon: 'x', run: () => void closeTab(p, group) },
          { label: 'Close Others', icon: 'x', run: () => void closeOtherTabs(p, group) },
          { label: 'Close Saved', icon: 'check', run: () => closeSavedTabs(group) },
          { label: 'Close All', icon: 'x', run: () => void closeAllTabs() },
          ...(isBolt ? [] : [
            { label: splitOpen ? 'Open in Other Group' : 'Split Right', icon: 'splitV' as const, run: () => void openInOtherGroup(p) },
            ...((!t.diff && !t.image && !t.preview && t.file && /\.md$/i.test(t.file)) ? [
              { label: 'Open Preview', icon: 'eye' as const, run: () => void openPreview(t.file!) },
            ] : []),
            { sep: true as const },
            {
              label: 'Copy Path', icon: 'file' as const,
              run: () => void copyText(f).then((ok) => toast(ok ? 'Path copied.' : 'Copy failed.', ok ? 'info' : 'error')),
            },
            { label: 'Reveal in Explorer', icon: 'folder' as const, run: () => void revealInTree(f) },
            {
              // OS file manager (the only reveal that works for detached,
              // outside-project tabs — tree reveal can't show those).
              label: 'Reveal in File Explorer', icon: 'external' as const,
              run: () => {
                void barang().app.revealPath(f).catch((err) => {
                  toast(`Reveal failed: ${(err as Error).message}`, 'error');
                });
              },
            },
          ]),
        ]);
      };
      const x = el('span', { class: 'tab-x', title: 'Close' });
      x.append(iconEl('x', 12));
      x.onclick = (e) => {
        e.stopPropagation();
        void closeTab(t.path, group);
      };
      b.append(x);
      host.append(b);
    }
  };

  const paintTabs = () => {
    const { tabs: ts, active, split, focus } = editorStore.get();
    // Welcome (shortcuts + recents) is an empty-state screen only: hidden
    // once any tab is open OR a project is loaded.
    welcome.classList.toggle('hidden', ts.length > 0 || root !== '');
    const activeIsBolt = !!active?.startsWith('bolt:');
    // Bolt renders center-wide (like before the split): it takes the whole
    // editor area while active, whatever the split state.
    editorCols.classList.toggle('hidden', ts.length === 0 || activeIsBolt);
    boltHost.classList.toggle('hidden', !activeIsBolt);
    // Strips ALWAYS repaint — even behind the bolt overlay or a closed
    // split. Skipping leaves stale tab buttons that outlive their tabs.
    paintStrip(tabs, 1, !split || focus === 1);
    if (split) {
      splitCol.classList.remove('hidden');
      paintStrip(tabs2, 2, focus === 2);
    } else {
      splitCol.classList.add('hidden');
      paintStrip(tabs2, 2, false); // clear: no stale buttons in the closed group
    }
    // Split toggle lives at the end of the primary strip.
    const spacer = el('span', { class: 'tabs-spacer' });
    const splitBtn = el('button', { class: 'icon-btn split-btn', title: 'Split editor right (Ctrl+\\)' }) as HTMLButtonElement;
    splitBtn.append(iconEl('splitV', 14));
    splitBtn.onclick = () => toggleSplit();
    tabs.append(spacer, splitBtn);
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
  const btnViewPomo = el('button', { class: 'icon-btn side-view-btn', title: 'Pomodoro (Ctrl+Shift+T)' }) as HTMLButtonElement;
  btnViewPomo.append(iconEl('timer', 15));
  viewBar.append(btnViewExplorer, btnViewScm, btnViewApi, btnViewSearch, btnViewPomo);
  const explorerHost = el('div', { class: 'side-view', id: 'view-explorer' });
  const scmHost = el('div', { class: 'side-view hidden', id: 'view-scm' });
  const apiHost = el('div', { class: 'side-view hidden', id: 'view-api' });
  const searchHost = el('div', { class: 'side-view hidden', id: 'view-search' });
  const pomoHost = el('div', { class: 'side-view hidden', id: 'view-pomo' });
  type SideView = 'explorer' | 'scm' | 'api' | 'search' | 'pomo';
  let searchApi: SearchApi | null = null;
  const setSideView = (v: SideView) => {
    // Any IDE navigation intent exits agentic mode first.
    requireIDE();
    explorerHost.classList.toggle('hidden', v !== 'explorer');
    scmHost.classList.toggle('hidden', v !== 'scm');
    apiHost.classList.toggle('hidden', v !== 'api');
    searchHost.classList.toggle('hidden', v !== 'search');
    pomoHost.classList.toggle('hidden', v !== 'pomo');
    btnViewExplorer.classList.toggle('active', v === 'explorer');
    btnViewScm.classList.toggle('active', v === 'scm');
    btnViewApi.classList.toggle('active', v === 'api');
    btnViewSearch.classList.toggle('active', v === 'search');
    btnViewPomo.classList.toggle('active', v === 'pomo');
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
  btnViewPomo.onclick = () => setSideView('pomo');
  const buildSideViews = () => {
    // Hosts persist across switches (view state lives on them) — clear their
    // painted content so re-init never stacks duplicate headers/trees.
    explorerHost.innerHTML = '';
    sidebar.innerHTML = '';
    sidebar.append(railBtn, viewBar, explorerHost, scmHost, apiHost, searchHost, pomoHost);
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
    if (v === 'scm' || v === 'api' || v === 'search' || v === 'pomo') setSideView(v as SideView);
  } catch { /* fresh default */ }

  // Sidebar Search view (project find + replace).
  searchApi = initSearchView(searchHost, {
    toast,
    revealInEditor: (p, line) => void revealInEditor(p, line),
    revealSearchMatch: (p, line, q, flags) => void revealSearchMatch(p, line, q, flags),
    clearHighlights: () => clearSearchDecorations(),
    refreshExplorer: () => {
      refreshExplorer();
      explorer.repaint();
    },
  });

  // Bolt API client (sidebar collections + center request tabs). Tab-strip
  // repaints flow through the editorStore subscription (every bolt mutation
  // already goes through editorStore.set), so onTabs is a noop.
  boltApi = initBolt(apiHost, { toast, onTabs: () => undefined });

  // Pomodoro timer (sidebar view + statusbar readout, own settings in-view).
  initPomodoro(pomoHost, { toast });

  // Hot project switch: no page reload (Monaco stays warm, no bundle
  // re-parse). Explorer re-inits, tabs reset, sessions reload scoped.
  let currentRoot = root;
  async function switchRoot(newRoot: string) {
    currentRoot = newRoot;
    root = newRoot;
    // Opening a folder always lands on the Explorer, not whichever view
    // was active last (search-in-progress, scm, ... stays per session).
    setSideView('explorer');
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
    await restoreTabSession().catch(() => {});
    void refreshAgenticMeta();
    paintModeButtons();
    void ensureSession();
  }

  // ---- Agentic Coding mode (opencode-style centered chat, no IDE) ----
  // Same chat stack (sessions, approvals, questions, history, queue), new
  // posture: sidebar/editor/terminal hide and the agent panel becomes a
  // centered column with a wordmark empty state + folder/branch row.
  // Any file-open intent exits back to the IDE (editor hook below).
  let agentic = false;
  const isAgentic = () => agentic;
  let composerPlaceholder = '';

  const agenticHero = el('div', { class: 'agentic-hero hidden' });
  agenticHero.append(el('div', { class: 'agentic-wordmark' }, 'BARANG'));
  agentPanel.prepend(agenticHero);

  const agenticMeta = el('div', { class: 'agentic-meta hidden' });
  const agenticFolderBtn = el('button', { class: 'agentic-folder', title: 'Switch project folder' }) as HTMLButtonElement;
  const agenticBranch = el('span', { class: 'agentic-branch hidden' });
  agenticMeta.append(agenticFolderBtn, el('span', { class: 'sep' }, '/'), agenticBranch);
  // Appended after initChat so it sits below the composer, like opencode.
  const mountAgenticMeta = () => agentPanel.append(agenticMeta);

  function paintAgenticHero() {
    if (!agentic) return;
    const empty = agentStore.get().messages.length === 0;
    agentPanel.classList.toggle('agentic-empty', empty);
    agenticHero.classList.toggle('hidden', !empty);
  }

  function setComposerAgentic(on: boolean) {
    const input = document.querySelector('.composer-input') as HTMLTextAreaElement | null;
    if (!input) return;
    if (on) {
      if (!composerPlaceholder) composerPlaceholder = input.placeholder;
      input.placeholder = 'Ask anything, / for commands, @ for context…';
      input.focus();
    } else if (composerPlaceholder) {
      input.placeholder = composerPlaceholder;
    }
  }

  function enterAgentic() {
    if (!agentStore.get().root) return;
    agentic = true;
    agentPanel.classList.remove('collapsed');
    paintModeButtons();
    document.body.classList.add('agentic');
    setComposerAgentic(true);
    void refreshAgenticMeta();
    paintAgenticHero();
    window.dispatchEvent(new Event('resize'));
  }

  function exitAgentic() {
    if (!agentic) return;
    agentic = false;
    document.body.classList.remove('agentic');
    agentPanel.classList.remove('agentic-empty');
    agenticHero.classList.add('hidden');
    paintModeButtons();
    setComposerAgentic(false);
    window.dispatchEvent(new Event('resize'));
  }

  function requireIDE() {
    if (agentic) exitAgentic();
  }

  /** Topbar IDE/Vibe toggle visibility (Vibe needs an open folder). */
  function paintModeButtons() {
    const hasRoot = !!agentStore.get().root;
    btnVibe.classList.toggle('hidden', agentic || !hasRoot);
    btnIDE.classList.toggle('hidden', !agentic);
  }

  async function refreshAgenticMeta() {
    if (!agentic) return;
    const r = agentStore.get().root || '';
    agenticMeta.classList.toggle('hidden', !r);
    if (!r) return;
    const name = r.split(/[\\/]/).filter(Boolean).pop() || r;
    agenticFolderBtn.innerHTML = '';
    agenticFolderBtn.append(iconEl('logo', 13), el('span', {}, name), iconEl('chevD', 12));
    agenticFolderBtn.title = r;
    try {
      const info = (await barang().git('info')) as { branch?: string } | null;
      const br = info?.branch;
      if (br) {
        agenticBranch.innerHTML = '';
        agenticBranch.append(iconEl('branch', 12), el('span', {}, br));
        agenticBranch.classList.remove('hidden');
      } else {
        agenticBranch.classList.add('hidden');
      }
    } catch {
      agenticBranch.classList.add('hidden');
    }
  }

  agenticFolderBtn.onclick = (e) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const here = agentStore.get().root || '';
    const items: Array<{ label: string; icon: 'folder' | 'folderPlus'; run: () => void }> = appRecents
      .filter((x) => x !== here)
      .slice(0, 5)
      .map((x) => ({
        label: x.split(/[\\/]/).filter(Boolean).pop() || x,
        icon: 'folder' as const,
        run: () => void openPathFlow(x),
      }));
    items.push({ label: 'Open folder…', icon: 'folderPlus' as const, run: () => openFolderFlow() });
    showContextMenu(rect.left, rect.bottom + 4, items);
  };

  async function enterAgenticFlow() {
    if (agentStore.get().root) {
      enterAgentic();
      return;
    }
    // Default folder ("Default", app-managed): no recents detour, no
    // dialog — Vibe always has somewhere to work.
    try {
      const res = await barang().app.defaultFolder();
      if (res?.root) {
        await openPathFlow(res.root);
      }
    } catch (err) {
      toast(`Could not open the Default folder: ${(err as Error).message}`, 'error');
      return;
    }
    if (!agentStore.get().root) return;
    enterAgentic();
    // Start screen → always a fresh session (never resume a stale one).
    try {
      await createSession();
    } catch (e) {
      toast(`New session failed: ${(e as Error).message}`, 'error');
    }
  }

  initChat(agentPanel, {
    toast,
    onOpenSettings: () => openSettings({ toast, onCheckUpdates: () => void refreshUpdateBadge(true) }),
    onOpenPalette: (prefill = '') => {
      if (palette.isOpen()) palette.close();
      palette.open(prefill ? `> ${prefill}` : '> ');
    },
  });
  mountAgenticMeta();
  // Any file landing in the editor exits agentic mode (a hidden editor
  // opening tabs would strand the user). Suppressed during restores.
  setFileOpenedHandler(() => requireIDE());
  agentStore.subscribe(() => paintAgenticHero());
  connectEvents();
  // Live file tree: the desktop watcher pings on agent/external writes so
  // new files appear without tab-switching or manual refresh. Debounced in
  // main (bursts) and here (paint); paint() itself never nukes an open
  // rename/create prompt, and SCM trails behind.
  let fsTimer: ReturnType<typeof setTimeout> | null = null;
  let scmTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    barang().app.onFsChanged(() => {
      if (fsTimer) clearTimeout(fsTimer);
      fsTimer = setTimeout(() => {
        fsTimer = null;
        refreshExplorer();
        explorer.repaint();
      }, 800);
      if (scmTimer) clearTimeout(scmTimer);
      scmTimer = setTimeout(() => {
        scmTimer = null;
        void scmApi.refresh();
      }, 2500);
    });
  } catch { /* bridge missing (browser tab) — manual refresh still works */ }
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
  // Tab session: reopen this project's working set (incl. detached tabs).
  void restoreTabSession().catch(() => {});
  paintModeButtons();
  // Agent notifications: Windows toast + taskbar badge + sound when a run
  // finishes, needs approval, or errors. Renderer decides, main toasts.
  armAudioUnlock();
  watchAgentNotifications((kind: NotifyKind) => {
    const s = readSettings();
    if (!s.notifEnabled) return;
    // User-driven stops (manual Stop, question answers) are never
    // completions — the abort arms a one-shot silence for its own edge.
    if (kind === 'done' && consumeQuietStop()) return;
    if (kind === 'done' && !s.notifOnDone) return;
    if (kind === 'approval' && !s.notifOnApproval) return;
    if (kind === 'question' && !s.notifOnQuestion) return;
    if (kind === 'error' && !s.notifOnError) return;
    const title = agentStore.get().error && kind === 'error'
      ? 'Barang — agent error'
      : kind === 'approval' ? 'Barang — approval needed'
      : kind === 'question' ? 'Barang — question waiting'
      : 'Barang — agent finished';
    const body = kind === 'error'
      ? (agentStore.get().error ?? 'The run failed.').slice(0, 200)
    : kind === 'approval'
      ? (() => {
        const bits: string[] = [];
        if (agentStore.get().permissions.length) bits.push(`${agentStore.get().permissions.length} approval(s)`);
        if (agentStore.get().questions.length) bits.push(`${agentStore.get().questions.length} question(s)`);
        return `${bits.join(' + ') || 'Something'} waiting for your review.`;
      })()
    : kind === 'question'
      ? (() => {
        const n = agentStore.get().questions.length;
        return n ? `${n} question${n === 1 ? '' : 's'} waiting for your answer.` : 'The agent has a question for you.';
      })()
        : (activeSessionTitle() ?? 'Your task is complete.');
    if (s.notifSound) {
      const url = resolveKindSound(
        kind,
        { done: s.notifDoneSound, approval: s.notifApprovalSound, question: s.notifQuestionSound, error: s.notifErrorSound },
        s.notifCustomSounds,
      );
      void playNotificationSound(url, s.notifVolume / 100);
    }
    const focused = document.hasFocus();
    if (!focused && s.notifNative) {
      void barang().app.notify({ title, body, kind, badge: s.notifTaskbar }).catch(() => undefined);
    } else if (focused && s.notifToastFocused) {
      // Vibe: run errors already show inline — skip the echo toast.
      if (!(agentic && kind === 'error')) toast(`${title.replace('Barang — ', '')}: ${body}`, kind === 'error' ? 'error' : 'info');
    }
  });
  // Smoke/introspection hook (read-only decision fn, like __barangTermBuffer).
  (window as unknown as { __barangNotifDecide: typeof decideAgentNotification }).__barangNotifDecide = decideAgentNotification;
  // Perf-cap introspection: pure helpers + decisions (unit-probed in smoke).
  (window as unknown as { __barangTestUtils: unknown }).__barangTestUtils = {
    sliceWindow,
    truncateText,
    tabPageRange,
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
    upsertPermission,
    removePermission,
    markPermissionAnswered,
    clearSessionPermissions,
    isPermissionStaleError,
    pruneAnsweredKeys,
    enqueueFollowUp,
    queuedFollowUps,
    dequeueFollowUp,
    removeQueuedFollowUp,
    clearQueuedFollowUps,
    drainQueue,
    deriveSessionChanges,
    parseUnifiedPatch,
    applyHunkSubset,
    changeFp,
    isReviewed,
    markReviewed,
    loadReviewedState,
    scheduleReviewedPersist,
    openLightbox,
    closeLightbox,
    resolveKindSound,
    KIND_DEFAULT_SOUND,
    normalizeNotifSoundSettings,
    playNotificationSound,
    quietNextStop,
    consumeQuietStop,
    debugAudioState,
    isTransportDown,
    findUserMessage,
    todoProgress,
    questionFromEvent,
    describeActivity,
    decideStatus,
    shortenMiddle,
    classifyAttachFile,
    usageCard,
    langOf,
    getTsDiagOptions,
    registeredLanguageIds,
    parseTsconfigPaths,
    matchAlias,
    packageNameOf,
    candidateImportPaths,
    specResolves,
    groupTabs,
    editorSplitState,
    pomoNext,
    formatClock,
    normalizePomoSettings,
    pomoDotsFilled,
    parseMcpFile,
    toServerList,
    buildFileText,
    validateServer,
    parseKvLines,
    toLiveConfig,
    wordpressQuickFill,
    wordpressEndpoint,
    mergeStatuses,
    isFreeTierGateError,
    freeTierGuidance,
    isModelAccessError,
    modelAccessGuidance,
    relayActive,
    relayRouteFor,
    modelListKey,
    derivePromptTitle,
    isUntitledSessionTitle,
    sessionDisplayTitle,
    decideRelayStuck,
    stuckContinueText,
    normEchoText,
    findUserMessageLoose,
    relayEchoGuard,
    isTransientRelayEcho,
    shouldRelayRoute,
    buildRelayArgs,
    parseRelayLine,
    relayProgressLabel,
    redactSecrets,
    RELAY_DISPLAY_NAME,
    validateProviderEntry,
    parseModelIds,
    normalizeProviderKey,
    providerToLiveConfig,
    setProviderEntry,
    removeProviderEntry,
    listProviderEntries,
    filePartView,
    stepHistory,
    pushComposerHist,
    openPreview,
    openFile,
    closeTab,
    revealSearchMatch,
    getSearchDecorCount,
    getEditorDisplayFlags,
    resolveSendVariant,
    loadCommands,
    parseSlashCommand,
    isRepeatAsk,
    pruneQuestions,
    upsertQuestion,
    removeQuestion,
    pathOf,
    dropPaths,
    saveActive,
    isAbsolutePath,
    openUntitled,
    closeAllTabs,
    flushTabSession,
    restoreTabSession,
    debugModelText,
    debugDisplayedText,
    enterAgenticFlow,
    exitAgentic,
    isAgentic,
    openPathFlow,
    debugSetMessages: (msgs: never[]) => agentStore.set({ messages: msgs }),
    debugSetError: (msg: string | null) => agentStore.set({ error: msg }),
    activeSessionId: () => agentStore.get().activeId,
    createSession,
    selectSession,
  };
  // Model/agent catalog + free-model defaults (Muse Spark when available).
  void loadMeta().catch((e) => toast(`opencode metadata: ${e.message}`, 'error'));

  const toggleAgent = () => {
    if (agentic) return; // the panel IS the agentic view — nothing to toggle
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
    toggleTerminalPanel: () => {
      if (agentic) {
        requireIDE();
        return;
      }
      termApi.toggle();
    },
    terminalNew: () => {
      requireIDE();
      termApi.newTerminal(true);
    },
    terminalClear: () => termApi.clearActive(),
    terminalKill: () => termApi.killActive(),
    splitToggle: () => {
      requireIDE();
      toggleSplit();
    },
    focusGroup: (g) => {
      requireIDE();
      focusGroup(g);
    },
    closeSplit: () => closeSplitGroup(),
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
    } else if (mod && e.key.toLowerCase() === 't' && e.shiftKey) {
      e.preventDefault();
      setSideView('pomo');
    } else if (mod && e.key.toLowerCase() === 's' && !termFocus) {
      e.preventDefault();
      requireIDE();
      if (e.shiftKey) {
        void saveAll();
      } else {
        const st = editorStore.get();
        const act = st.focus === 2 && st.split ? st.active2 : st.active;
        if (act?.startsWith('bolt:')) {
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
      requireIDE();
      openUntitled();
    } else if (mod && e.key.toLowerCase() === 'w' && !e.shiftKey && !termFocus) {
      e.preventDefault();
      requireIDE();
      const st = editorStore.get();
      const act = st.focus === 2 && st.split ? st.active2 : st.active;
      if (act) void closeTab(act);
    } else if (mod && e.key === '\\' && !e.shiftKey) {
      // Split editor right (VSCode Ctrl+\). Backquote is the terminal chord.
      e.preventDefault();
      requireIDE();
      toggleSplit();
    } else if (mod && (e.key === '1' || e.key === '2') && !e.shiftKey) {
      e.preventDefault();
      requireIDE();
      void focusGroup(e.key === '2' ? 2 : 1);
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
      if (agentic) {
        requireIDE();
        return;
      }
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
