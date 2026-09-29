// Barang desktop entry: single window, native menu, IPC backend.
// Backend = direct function calls (fs + owned opencode server). No HTTP ports,
// no auth in the UI: model credentials stay inside the user's opencode CLI.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as files from './files.js';
import { ensureServer, restartServer, stopServer, ocCall, opencodeState, attachPumpHandlers } from './opencodeClient.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // electron/main
const APP_DIR = path.resolve(here, '..', '..');
const DIST_DIR = path.join(APP_DIR, 'web', 'dist');
const VITE_URL = process.env.BARANG_VITE || ''; // `npm run dev` sets this
const SMOKE = process.argv.includes('--smoke');
const SMOKE_UI = process.argv.includes('--smoke-ui');

// Boot-stage log (packaged GUI apps have no console: this file is the debugger).
function bootLog(stage, extra = '') {
  try {
    const dir = process.env.TEMP || process.env.TMP || '/tmp';
    fs.appendFile(
      path.join(dir, 'barang-boot.log'),
      `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(0, 4))} ${stage} ${extra}\n`,
    );
  } catch {
    /* noop */
  }
}
bootLog('module-loaded');

let win = null;
let root = process.env.BARANG_ROOT || '';
let statePath = '';

function userStatePath() {
  return path.join(app.getPath('userData'), 'barang.json');
}

async function loadState() {
  statePath = userStatePath();
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const saved = JSON.parse(raw);
    if (!root && typeof saved.root === 'string') root = saved.root;
  } catch {
    /* first run */
  }
  if (!root) root = app.getPath('documents');
}

async function saveState() {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ root }), 'utf8');
  } catch {
    /* non-fatal */
  }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* noop */
    }
  }
}

async function bootOpencode() {
  try {
    await fs.stat(root);
  } catch {
    root = app.getPath('documents');
  }
  await ensureServer(root, { onLog: (line) => console.log(line.trimEnd()) });
}

function createWindow() {
  // Product logo for the window/taskbar (shipped verbatim by sync-logo.js).
  const logoPath = path.join(DIST_DIR, 'barang-logo.png');
  const windowIcon = existsSync(logoPath) ? logoPath : undefined;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#101012',
    autoHideMenuBar: true,
    icon: windowIcon,
    // Dark window chrome: no native titlebar; the OS draws only the
    // min/max/close overlay (dark) while our topbar is the drag region.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#101012',
      symbolColor: '#a1a1aa',
      height: 46,
    },
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (VITE_URL) {
    win.loadURL(VITE_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(DIST_DIR, 'index.html'));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Agent messages can contain links — open them in the real browser.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

// No native application menu by design: the topbar (Open / Palette / Agent /
// Settings), the command palette, and renderer keybindings own every action.
function applyNoMenu() {
  Menu.setApplicationMenu(null);
}

async function handleOpenFolder() {
  const picked = await dialog.showOpenDialog(win ?? undefined, {
    properties: ['openDirectory'],
    defaultPath: root,
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  root = picked.filePaths[0];
  await saveState();
  await restartServer(root, { onLog: (line) => console.log(line.trimEnd()) });
  broadcast('app:root-changed', { root });
  return { root };
}

// --- IPC -----------------------------------------------------------------
function registerIpc() {
  const ok = (fn) => async (_ev, payload = {}) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };

  ipcMain.handle('fs:tree', ok((p) => files.tree(root, p)));
  ipcMain.handle('fs:read', ok((p) => files.readFile(root, p.path)));
  ipcMain.handle('fs:write', ok((p) => files.writeFile(root, p.path, p.content)));
  ipcMain.handle('fs:mkdir', ok((p) => files.mkdir(root, p.path)));
  ipcMain.handle('fs:rename', ok((p) => files.renamePath(root, p.from, p.to)));
  ipcMain.handle('fs:remove', ok((p) => files.removePath(root, p.path)));
  ipcMain.handle('fs:read-external', ok((p) => files.readExternal(p.path)));
  ipcMain.handle('fs:find', ok((p) => files.find(root, p)));
  ipcMain.handle('fs:search', ok((p) => files.search(root, p)));

  ipcMain.handle('oc:call', async (_ev, p = {}) => {
    try {
      const res = await ocCall(p.path, { method: p.method || 'GET', body: p.body });
      return { ok: true, status: res.status, text: res.text };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('app:state', () => ({
    root,
    opencode: opencodeState(),
    versions: { app: app.getVersion(), electron: process.versions.electron },
  }));
  ipcMain.handle('app:open-folder', async () => {
    const res = await handleOpenFolder();
    return res ? { ok: true, data: res } : { ok: false, error: 'cancelled' };
  });
  ipcMain.handle('app:pick-files', async () => {
    // Composer attachments: images (inline) or any file (@mention).
    const picked = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: root,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled) return { ok: false, error: 'cancelled' };
    const out = [];
    for (const abs of picked.filePaths) {
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) out.push({ path: abs, name: path.basename(abs), size: stat.size });
      } catch { /* skip unreadable picks */ }
    }
    return { ok: true, data: { files: out } };
  });
}

// --- smoke modes (headless CI without a display) --------------------------
async function runMainSmoke() {
  // Exercises the real desktop backend: opencode spawn + fs + session lifecycle.
  // Results are tee'd to a log file (survives any stdio weirdness on Windows).
  const logPath = path.join(app.getPath('temp'), 'barang-smoke.log');
  const log = (line) => {
    console.log(line);
    try {
      fs.appendFile(logPath, line + '\n');
    } catch {
      /* noop */
    }
  };
  try {
    await fs.writeFile(logPath, '');
  } catch {
    /* noop */
  }
  log(`[smoke] argv: ${JSON.stringify(process.argv.slice(1))} electron=${process.versions.electron}`);
  const results = [];
  const check = (name, fn) =>
    fn()
      .then((detail) => results.push({ name, pass: true, detail }))
      .catch((e) => results.push({ name, pass: false, detail: e.message }));
  await check('opencode-server', async () => {
    const s = opencodeState();
    if (!s.running) throw new Error('server not running');
    return `${s.version} @ ${s.base}`;
  });
  await check('fs-tree', async () => `${(await files.tree(root, {})).children.length} entries in ${root}`);
  await check('fs-write-read', async () => {
    await files.mkdir(root, '.barang-smoke');
    await files.writeFile(root, '.barang-smoke/ping.txt', 'pong');
    const f = await files.readFile(root, '.barang-smoke/ping.txt');
    if (f.content !== 'pong') throw new Error('roundtrip mismatch');
    await fs.rm(path.join(root, '.barang-smoke'), { recursive: true, force: true });
    return 'roundtrip ok';
  });
  await check('oc-agents', async () => {
    const r = await ocCall('/agent');
    const list = JSON.parse(r.text);
    const arr = Array.isArray(list) ? list : list.value;
    if (!arr?.length) throw new Error('no agents');
    return arr.map((a) => a.name).join(',');
  });
  await check('oc-session-lifecycle', async () => {
    const c = await ocCall('/session', { method: 'POST', body: { title: 'barang smoke' } });
    const s = JSON.parse(c.text);
    if (!s.id) throw new Error('no session id');
    await ocCall(`/session/${s.id}`, { method: 'DELETE' });
    return s.id;
  });
  let failed = 0;
  for (const r of results) {
    log(`[smoke] ${r.pass ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`);
    if (!r.pass) failed++;
  }
  log(`[smoke] done failed=${failed} log=${logPath}`);
  stopServer();
  // Give the tree-kill a beat to finish, then exit hard (no event-loop hang).
  setTimeout(() => app.exit(failed ? 1 : 0), 1500);
}

async function runUiSmoke() {
  // Headless render: hidden window loads the built UI, we collect console
  // errors and assert the shell painted, then quit. No display needed.
  app.commandLine.appendSwitch('headless');
  await app.whenReady();
  const errors = [];
  const w = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.webContents.on('console-message', (_e, _level, message) => {
    if (/error/i.test(message)) errors.push(message.slice(0, 200));
  });
  w.webContents.on('page-title-updated', (e) => e.preventDefault());
  await w.loadFile(path.join(DIST_DIR, 'index.html'));
  await new Promise((r) => setTimeout(r, 8000));
  const probe = await w.webContents
    .executeJavaScript(
      `(async () => {
        const q = (s) => document.querySelector(s);
        const qa = (s) => [...document.querySelectorAll(s)];
        // Explorer context menu: synthetic right-click must open a populated
        // menu, and Escape must close it.
        let ctxMenu = false, ctxItems = 0, ctxClosed = false;
        try {
          const lbl = qa('.tree-label')[0];
          if (lbl) {
            const r = lbl.getBoundingClientRect();
            lbl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
            await new Promise((rr) => setTimeout(rr, 400));
            const m = q('.ctx-menu');
            ctxMenu = !!m;
            ctxItems = m ? m.querySelectorAll('.ctx-item').length : 0;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise((rr) => setTimeout(rr, 300));
            ctxClosed = !q('.ctx-menu');
          }
        } catch {}
        // Explorer nesting invariant: expanding folders (including NESTED
        // ones) must never duplicate the tree — a label's depth must equal
        // its path depth (regression: repaint used the sub-div as root).
        let treeBad = -1;
        try {
          const depthOf = (b) => {
            let d = 0, n = b.parentElement;
            while (n) {
              if (n.classList && n.classList.contains('tree-sub')) d++;
              n = n.parentElement;
            }
            return d;
          };
          const clickDir = async (nested) => {
            const btn = qa('.tree-label').find((b) => {
              if (!b.querySelector('.tw')) return false;
              const inSub = !!b.closest('.tree-sub');
              return nested ? inSub : !inSub;
            });
            if (!btn) return false;
            btn.click();
            await new Promise((r) => setTimeout(r, 700));
            return true;
          };
          if (await clickDir(false)) await clickDir(true);
          const labels = qa('.tree-label');
          treeBad = labels.filter((b) => {
            const t = (b.title || '').replace(/\\\\/g, '/');
            if (!t) return false;
            return depthOf(b) !== t.split('/').length - 1;
          }).length;
        } catch { treeBad = -2; }
        // Status-bar dots: every svg inside .status-item must share its
        // vertical center within 2px (catches line-height sink regressions).
        let dotAlign = 'skip', dotDelta = -1;
        try {
          const items = qa('.status-item').filter((n) => n.querySelector('svg'));
          if (items.length) {
            dotDelta = Math.max(...items.map((n) => {
              const r = n.getBoundingClientRect();
              const s = n.querySelector('svg').getBoundingClientRect();
              return Math.abs((r.top + r.height / 2) - (s.top + s.height / 2));
            }));
            dotAlign = dotDelta <= 2 ? 'ok' : 'off';
          }
        } catch { dotAlign = 'error'; }
        // Session diff review: open the first IN-ROOT change row (absolute
        // out-of-root rows can only ever toast) and require a review UI —
        // Monaco side-by-side tab or patch fallback. Otherwise skip.
        let diffTab = 'skip', seenToast = '';
        try {
          const rows = qa('.changes-sec .change-row');
          const row = rows.find((r) => !/^[A-Za-z]:\\//.test(r.querySelector('.change-path')?.textContent || ''));
          if (row) {
            row.click();
            const t2 = Date.now();
            while (Date.now() - t2 < 15000) {
              const panes = qa('.editor-pane').filter((d) => !d.classList.contains('hidden'));
              if (q('.tab.is-diff') && panes.some((d) => d.querySelector('.monaco-editor'))) { diffTab = 'ok'; break; }
              if (q('.patch-overlay .patch-modal')) { diffTab = 'ok-patch'; break; }
              const tt = [...document.querySelectorAll('#toasts .toast')].map((t) => (t.textContent || '').trim().slice(0, 130)).join(' | ');
              if (tt) seenToast = tt;
              await new Promise((r) => setTimeout(r, 500));
            }
            if (diffTab !== 'ok' && diffTab !== 'ok-patch') diffTab = 'missing:' + seenToast;
          }
        } catch { diffTab = 'error'; }
        // Changes collapse: toggle hides/shows the file list. Skip when empty.
        let collapse = 'skip', statColors = 'skip';
        try {
          const tgl = q('.changes-sec .changes-toggle');
          if (tgl && q('.changes-sec .change-row')) {
            tgl.click();
            await new Promise((r) => setTimeout(r, 300));
            const hid = q('.changes-list').classList.contains('hidden');
            tgl.click();
            await new Promise((r) => setTimeout(r, 300));
            const shown = !q('.changes-list').classList.contains('hidden');
            collapse = hid && shown ? 'ok' : 'broken';
            statColors = q('.change-stat .stat-add') ? 'ok' : 'missing';
          }
        } catch { collapse = 'error'; }
        // Open Settings (also under test) so the modal assertions can run.
        const btn = q('.settings-btn');
        if (btn) btn.click();
        await new Promise((rr) => setTimeout(rr, 600));
        // fs rename/remove roundtrip over the REAL IPC chain (temp dir in root).
        let fsRoundtrip = 'skip';
        try {
          await window.barang.fs.write('.barang-smoke-ui/ping.txt', 'pong');
          const r = await window.barang.fs.rename('.barang-smoke-ui/ping.txt', '.barang-smoke-ui/pong.txt');
          const f = await window.barang.fs.read('.barang-smoke-ui/pong.txt');
          fsRoundtrip = r.path === '.barang-smoke-ui/pong.txt' && f.content === 'pong' ? 'ok' : 'mismatch';
        } catch (e) {
          fsRoundtrip = 'error: ' + (e.message || e);
        }
        try { await window.barang.fs.remove('.barang-smoke-ui'); } catch {}
        return JSON.stringify({
          fsRoundtrip,
          brand: q('.brand-name')?.textContent || null,
          brandImg: !!q('.brand img.brand-logo'),
          banner: !!q('.oc-banner:not(.hidden)'),
          hasEditor: !!q('.editor-host'),
          hasAgent: !!q('.agent-panel'),
          gutters: qa('.gutter-v').length,
          icons: qa('.ic svg').length,
          selects: qa('.agent-panel select').length,
          attachBtn: !!q('.composer .attach-btn'),
          modelMini: !!q('.composer .model-mini'),
          sendIcon: (() => { const b = q('.composer .btn-primary'); return !!b && !((b.textContent || '').trim()); })(),
          brandAlign: (() => {
            const img = q('.brand img'), name = q('.brand .brand-name');
            if (!img || !name) return { s: 'skip', d: -1 };
            const a = img.getBoundingClientRect(), b = name.getBoundingClientRect();
            const d = Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
            return { s: d <= 2 ? 'ok' : 'off', d };
          })(),
          changesSec: !!q('.changes-sec'),
          settingsBtn: !!btn,
          settingsModal: !!q('.settings-overlay .settings-modal select.settings-select'),
          defaultModel: (() => { const s = q('.settings-overlay select.settings-select'); return s ? s.value : null; })(),
          ctxMenu, ctxItems, ctxClosed,
          diffTab, collapse, statColors, dotAlign, dotDelta, treeBad,
          reasoningShown: qa('.tool-row summary').filter((s) => (s.textContent || '').trim() === 'Reasoning').length,
          stepRows: qa('.tool-row summary').filter((s) => /^step[\\s-_]*(start|finish)?/i.test((s.textContent || '').trim())).length,
          revertBtns: qa('.msg-action').length,
          headings: qa('.msg-md h1,.msg-md h2,.msg-md h3,.msg-md h4').length,
          toolRows: qa('.tool-row').length,
          emptyRows: qa('.tool-row').filter((d) => { const b = d.querySelector('.tool-body'); return !b || !b.textContent.trim(); }).length,
          emoji: (document.body.innerText.match(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u) || []).length,
        });
      })()`,
    )
    .catch((e) => `EVAL-FAIL: ${e.message}`);
  console.log('[smoke-ui] dom:', probe);
  console.log('[smoke-ui] console-errors:', errors.length ? errors.slice(0, 10) : 'none');
  const dom = JSON.parse(probe.startsWith('{') ? probe : '{}');
  const pass = dom.brand === 'Barang' && dom.brandImg === true && dom.hasEditor && dom.hasAgent &&
    dom.gutters === 2 && dom.icons >= 8 && dom.selects === 2 && dom.emoji === 0 &&
    dom.emptyRows === 0 && dom.settingsBtn === true && dom.settingsModal === true &&
    dom.reasoningShown === 0 && dom.stepRows === 0 &&
    dom.ctxMenu === true && dom.ctxItems >= 4 && dom.ctxClosed === true &&
    dom.fsRoundtrip === 'ok' && dom.changesSec === true &&
    dom.attachBtn === true && dom.modelMini === true && dom.sendIcon === true &&
    (dom.brandAlign.s === 'ok' || dom.brandAlign.s === 'skip') &&
    (dom.diffTab === 'ok' || dom.diffTab === 'ok-patch' || dom.diffTab === 'skip') &&
    (dom.collapse === 'ok' || dom.collapse === 'skip') &&
    (dom.statColors === 'ok' || dom.statColors === 'skip') &&
    (dom.dotAlign === 'ok' || dom.dotAlign === 'skip') &&
    dom.treeBad === 0;
  console.log(`[smoke-ui] fs-ipc-roundtrip: ${dom.fsRoundtrip}`);
  console.log(`[smoke-ui] composer: attach=${dom.attachBtn} model=${dom.modelMini} sendIcon=${dom.sendIcon} brandAlign=${dom.brandAlign.s} (${typeof dom.brandAlign.d === 'number' ? dom.brandAlign.d.toFixed(2) : dom.brandAlign.d}px)`);
  console.log(`[smoke-ui] ctx-menu: ${dom.ctxMenu} (${dom.ctxItems} items, esc-closes: ${dom.ctxClosed})`);
  console.log(`[smoke-ui] diff-review: ${dom.diffTab}, collapse: ${dom.collapse}, stat-colors: ${dom.statColors}`);
  console.log(`[smoke-ui] dot-align: ${dom.dotAlign} (max delta ${typeof dom.dotDelta === 'number' ? dom.dotDelta.toFixed(2) : dom.dotDelta}px)`);
  console.log(`[smoke-ui] tree-nesting-violations: ${dom.treeBad}`);
  console.log(`[smoke-ui] reasoning-shown: ${dom.reasoningShown}, step-rows: ${dom.stepRows}, revert-buttons: ${dom.revertBtns}`);
  if (dom.toolRows > 0) console.log(`[smoke-ui] tool-rows: ${dom.toolRows}, headings: ${dom.headings}`);
  console.log(`[smoke-ui] default-model: ${dom.defaultModel === '' ? '(auto)' : dom.defaultModel}`);
  if (dom.emptySamples?.length) console.log('[smoke-ui] empty-samples:', JSON.stringify(dom.emptySamples, null, 1));
  console.log(`[smoke-ui] ${pass ? 'PASS' : 'FAIL'}`);
  stopServer();
  app.exit(pass ? 0 : 1);
}

// --- boot -----------------------------------------------------------------
attachPumpHandlers({
  onFrame: (data) => broadcast('opencode:event', { data }),
  onConn: (connected) => broadcast('opencode:conn', { connected }),
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SMOKE && !SMOKE_UI) {
  app.quit();
} else {
  if (!SMOKE && !SMOKE_UI) {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
  app.whenReady().then(async () => {
    bootLog('when-ready');
    await loadState();
    bootLog('state-loaded', `root=${root}`);
    registerIpc();
    try {
      await bootOpencode();
      bootLog('opencode-ready', JSON.stringify(opencodeState()));
    } catch (e) {
      // opencode missing: the desktop still boots for editing; the renderer
      // shows the install banner from app:state (running:false).
      bootLog('opencode-failed', e.message);
      console.error('[barang] ' + e.message);
    }
    if (SMOKE) {
      bootLog('smoke-start');
      await runMainSmoke();
      return;
    }
    if (SMOKE_UI) {
      await runUiSmoke();
      return;
    }
    applyNoMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    stopServer(); // tree-kill the owned `opencode serve`
  });
}
