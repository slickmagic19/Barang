// Barang desktop entry: single window, native menu, IPC backend.
// Backend = direct function calls (fs + owned opencode server). No HTTP ports,
// no auth in the UI: model credentials stay inside the user's opencode CLI.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as files from './files.js';
import * as updater from './updater.js';
import { ensureServer, restartServer, stopServer, ocCall, opencodeState, attachPumpHandlers } from './opencodeClient.js';
import * as term from './terminal.js';
import * as scm from './git.js';
import * as api from './api.js';

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
// Windows toast attribution (both dev and packaged): without an AUMID the
// OS files our toasts under a generic host instead of Barang.
try {
  app.setAppUserModelId('ai.barang.editor');
} catch {
  /* very old Electron — ignore */
}

let win = null;
let root = process.env.BARANG_ROOT || ''; // '' = no project (welcome state)
let recents = []; // most-recent-first project roots (max 8)
let restoreProject = false; // Settings > Startup: reopen last project
let statePath = '';

// Notification attention state (module scope: window focus clears it no
// matter which handler raised it).
let notifCount = 0;
function clearAttention() {
  notifCount = 0;
  try {
    app.setBadgeCount(0);
  } catch {
    /* noop */
  }
  try {
    if (win) win.flashFrame(false);
  } catch {
    /* noop */
  }
}

function userStatePath() {
  return path.join(app.getPath('userData'), 'barang.json');
}

async function loadState() {
  statePath = userStatePath();
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.recents)) {
      recents = saved.recents.filter((r) => typeof r === 'string').slice(0, 8);
    }
    restoreProject = saved.restore === true;
    // Reopen the last project only when enabled (default: welcome state).
    if (!root && restoreProject && typeof saved.root === 'string') root = saved.root;
  } catch {
    /* first run */
  }
}

async function saveState() {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ root, recents, restore: restoreProject }), 'utf8');
  } catch {
    /* non-fatal */
  }
}

/** Remember a project (dedupe case-insensitively, cap 8) and persist. */
async function touchRecent(dir) {
  const norm = dir.toLowerCase();
  recents = [dir, ...recents.filter((r) => r.toLowerCase() !== norm)].slice(0, 8);
  await saveState();
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

let rootWatcher = null; // fs watcher for the open project (live explorer)
let watchTimer = null;

/** Watch the open project for agent/external file changes and nudge the UI.
 *  Single debounced ping per burst (npm installs settle into one refresh).
 *  No-op without a project; re-armed on every project switch. */
function watchProject(dir) {
  try {
    rootWatcher?.close();
  } catch { /* noop */ }
  rootWatcher = null;
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (!dir) return;
  try {
    rootWatcher = fsWatch(dir, { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        broadcast('app:fs-changed', { root: dir });
      }, 800);
    });
    rootWatcher.on('error', () => {
      try {
        rootWatcher?.close();
      } catch { /* noop */ }
      rootWatcher = null;
    });
  } catch (e) {
    bootLog('watch-failed', e?.message || String(e));
  }
}

async function bootOpencode() {
  // With no project open, the agent server idles in a scratch dir inside
  // userData (never in the app folder or Documents).
  const cwd = root || path.join(app.getPath('userData'), 'scratch');
  try {
    await fs.mkdir(cwd, { recursive: true });
    await fs.stat(cwd);
  } catch {
    /* last resort: serve fails loudly below with a clear error */
  }
  await ensureServer(cwd, { onLog: (line) => console.log(line.trimEnd()), extraEnv: await mcpEnv() });
}

/** Barang-managed MCP config file (global scope). opencode merges it over
 *  every other layer, so Barang never edits the user's own config files
 *  for global servers. Respects a user-set OPENCODE_CONFIG. */
function managedMcpPath() {
  return path.join(app.getPath('userData'), 'opencode-mcp.json');
}

async function ensureManagedMcp() {
  const p = managedMcpPath();
  const cur = await fs.readFile(p, 'utf8').catch(() => null);
  if (cur === null) {
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
    } catch { /* noop */ }
    await fs.writeFile(p, '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n').catch(() => {});
  }
  return p;
}

/** Extra env for the opencode server: point it at our managed MCP file
 *  unless the user already overrides config discovery themselves. */
async function mcpEnv() {
  if (process.env.OPENCODE_CONFIG) return {};
  try {
    return { OPENCODE_CONFIG: await ensureManagedMcp() };
  } catch {
    return {};
  }
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
  // Regaining focus acknowledges every pending notification: taskbar badge
  // and flashing stop immediately (VSCode behavior).
  win.on('focus', () => {
    clearAttention();
  });
  ensureStartMenuShortcut();
}

// Windows toast attribution: the OS names toasts after the Start Menu
// shortcut carrying our AppUserModelID. Without one, toasts show the raw
// ID ("ai.barang.editor"). Portable builds have no installer, so we keep
// our own shortcut fresh (path updates when the portable moves). Dev runs
// (electron.exe) are skipped — never link the Start Menu to Electron.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdir(dir, { recursive: true }).then(async () => {
      try {
        // Stable icon: the shortcut must NOT point into the portable's
        // TEMP extraction dir (it changes every version). Vault our icon
        // into userData once and link that instead.
        let iconPath = process.execPath;
        try {
          const vault = path.join(app.getPath('userData'), 'barang-icon.ico');
          // Always refresh: a rebrand (new shipped icon) must replace the
          // vaulted copy, not linger behind a copy-once shortcut icon.
          // Dev fallback: resourcesPath has no icon.ico outside the packaged
          // app, so fall back to the repo build output (same file).
          const candidates = [
            path.join(process.resourcesPath, 'icon.ico'),
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'icon.ico'),
          ];
          for (const src of candidates) {
            try {
              await fs.copyFile(src, vault);
              break;
            } catch {
              /* try next */
            }
          }
          try {
            await fs.stat(vault);
            iconPath = vault;
          } catch {
            /* fall back to the exe's embedded icon */
          }
        } catch {
          /* fall back to the exe's embedded icon */
        }
        // writeShortcutLink 'update' silently ignores some fields (icon) —
        // recreate from scratch so target/icon/AUMID always self-heal.
        const link = path.join(dir, 'Barang.lnk');
        try {
          await fs.unlink(link);
        } catch {
          /* first run */
        }
        shell.writeShortcutLink(link, 'create', {
          target: process.execPath,
          description: 'Barang — lightweight code editor with opencode agents',
          appUserModelId: 'ai.barang.editor',
          icon: iconPath,
          iconIndex: 0, // required: without it the icon field is ignored
        });
        bootLog('shortcut-ok', link);
      } catch (e) {
        bootLog('shortcut-failed', e?.message || String(e));
      }
    }).catch(() => {
      /* noop */
    });
  } catch {
    /* noop */
  }
}

// No native application menu by design: the topbar (Open / Palette / Agent /
// Settings), the command palette, and renderer keybindings own every action.
function applyNoMenu() {
  Menu.setApplicationMenu(null);
}

async function handleOpenFolder() {
  const picked = await dialog.showOpenDialog(win ?? undefined, {
    properties: ['openDirectory'],
    defaultPath: root || undefined,
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return openPath(picked.filePaths[0]);
}

let updateCache = null; // { at, info } — releases check, 1h TTL

function cmpVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** The user's own portable exe, when discoverable (the running process is
 *  a temp-extracted copy, so process.execPath is useless — electron-builder
 *  exposes the original via PORTABLE_EXECUTABLE_FILE). Null in dev. */
function originalExePath() {
  const cands = [process.env.PORTABLE_EXECUTABLE_FILE, app.isPackaged ? process.execPath : ''];
  for (const c of cands) {
    if (!c) continue;
    try {
      if (updater.REPLACE_BASENAME.test(path.basename(c)) && existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Check slickmagic19/Barang releases for a newer tag. Never throws fatally
 *  (offline/blocked networks just report no update). */
async function checkForUpdates() {
  const now = Date.now();
  if (updateCache && now - updateCache.at < 3600000) return updateCache.info;
  const info = { update: false, current: app.getVersion(), packaged: app.isPackaged };
  try {
    const res = await fetch('https://api.github.com/repos/slickmagic19/Barang/releases/latest', {
      headers: { 'user-agent': 'barang-updater', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    info.version = String(rel.tag_name || '');
    info.url = rel.html_url || '';
    const asset = (rel.assets || []).find((a) => /Barang-.*-win\.exe$/i.test(a?.name || ''));
    if (asset) info.asset = { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 };
    info.update = !!latest && cmpVersions(latest, info.current) > 0;
  } catch (e) {
    info.error = e?.message || String(e);
  }
  // Replace-my-file target (null when undiscoverable, e.g. dev).
  try {
    info.replaceTarget = info.update ? originalExePath() : null;
  } catch {
    info.replaceTarget = null;
  }
  updateCache = { at: now, info };
  return info;
}

let updateDownload = null; // in-flight download promise (single flight)

/** Download the pending update asset to temp with progress events.
 *  Resolves { ok, path } — reuses a complete earlier download. */
async function downloadUpdate() {
  if (updateDownload) return updateDownload;
  updateDownload = (async () => {
    const info = await checkForUpdates();
    if (!info.update || !info.asset?.url) throw new Error('no update available');
    const dest = path.join(app.getPath('temp'), info.asset.name);
    const have = await fs.stat(dest).catch(() => null);
    if (have && info.asset.size && have.size === info.asset.size) return dest;
    const res = await fetch(info.asset.url, { headers: { 'user-agent': 'barang-updater' } });
    if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || info.asset.size || 0);
    const fh = await fs.open(dest, 'w');
    let received = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value);
        received += value.length;
        win?.webContents.send('app:update-progress', { received, total, path: dest });
      }
    } finally {
      await fh.close();
    }
    const st = await fs.stat(dest).catch(() => null);
    if (!st || !st.size) throw new Error('download produced an empty file');
    if (info.asset.size && st.size !== info.asset.size) {
      await fs.unlink(dest).catch(() => {});
      throw new Error(`size mismatch (${st.size}/${info.asset.size}) — try again`);
    }
    return dest;
  })();
  try {
    return await updateDownload;
  } finally {
    updateDownload = null;
  }
}

/** Complete a replace-my-original pending from the previous version's
 *  apply-update: copy the download over the user's exe (polling until the
 *  old process releases it), report via the update-progress channel, and
 *  always consume the marker. Never throws. */
async function handlePendingReplace() {
  const tempDir = app.getPath('temp');
  const marker = await updater.readReplaceMarker(tempDir);
  if (!marker) return;
  bootLog('replace-pending', `${marker.source} -> ${marker.target}`);
  const done = async () => updater.clearReplaceMarker(tempDir);
  try {
    const r = await updater.replaceOriginalExe({ source: marker.source, target: marker.target });
    bootLog('replace-done', `${r.bytes} bytes -> ${marker.target}`);
    await done();
    // Temp download served its purpose — remove it (best effort).
    await fs.unlink(marker.source).catch(() => {});
    win?.webContents.send('app:update-progress', { received: 1, total: 1, replaced: marker.target });
  } catch (e) {
    const msg = e?.message || String(e);
    bootLog('replace-error', msg);
    await done();
    win?.webContents.send('app:update-progress', { received: 0, total: 0, replaceError: msg });
  }
}

/** Open a project directly (recent list, welcome screen, palette).
 *  Fast path: the UI switches instantly (files are local); the agent server
 *  reboots in the background and announces readiness separately. */
async function openPath(dir) {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error('Folder no longer exists: ' + dir);
  }
  if (!stat.isDirectory()) throw new Error('Not a folder: ' + dir);
  root = dir;
  await touchRecent(root);
  watchProject(root);
  broadcast('app:root-changed', { root });
  restartServer(root, { onLog: (line) => console.log(line.trimEnd()), extraEnv: await mcpEnv() }).then(
    () => broadcast('opencode:ready', { root }),
    (e) => {
      if (!/superseded/.test(e?.message || '')) broadcast('opencode:error', { error: e?.message || String(e) });
    },
  );
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

  /** Workspace calls require an open project (root '' = welcome state). */
  const needRoot = (fn) => async (p) => {
    if (!root) throw new Error('No folder open');
    return fn(p);
  };

  ipcMain.handle('fs:tree', ok(needRoot((p) => files.tree(root, p))));
  ipcMain.handle('fs:list-files', ok(needRoot(() => files.listFiles(root))));
  ipcMain.handle('fs:stat-paths', ok(async (p = {}) => {
    // Absolute-path stats for OS drag-drop (may live outside the project).
    const out = [];
    for (const raw of ((p.paths ?? [])).slice(0, 20)) {
      const abs = String(raw || '');
      if (!abs) continue;
      try {
        const st = await fs.stat(abs);
        out.push({ path: abs, exists: true, isDir: st.isDirectory() });
      } catch {
        out.push({ path: abs, exists: false, isDir: false });
      }
    }
    return out;
  }));
  ipcMain.handle('app:reveal-path', ok(async (p = {}) => {
    const rel = String(p.path || '');
    if (!rel) throw new Error('No path');
    // Absolute paths (detached tabs) are allowed anywhere: like
    // readAbsolute/writeAbsolute they always come from an explicit user
    // gesture, and this op is read-only. Root-relative paths stay confined.
    const abs = path.isAbsolute(rel) ? rel : root ? path.join(root, rel) : '';
    if (!abs) throw new Error('No folder open');
    if (!path.isAbsolute(rel)) {
      const norm = path.normalize(abs);
      const rnorm = path.normalize(root);
      if (norm !== rnorm && !norm.startsWith(rnorm + path.sep)) throw new Error('Outside the project');
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new Error('File no longer exists');
    shell.showItemInFolder(abs);
    return { revealed: true };
  }));
  ipcMain.handle('fs:read', ok(needRoot((p) => files.readFile(root, p.path))));
  ipcMain.handle('fs:write', ok(needRoot((p) => files.writeFile(root, p.path, p.content))));
  ipcMain.handle('fs:mkdir', ok(needRoot((p) => files.mkdir(root, p.path))));
  ipcMain.handle('fs:rename', ok(needRoot((p) => files.renamePath(root, p.from, p.to))));
  ipcMain.handle('fs:remove', ok(needRoot((p) => files.removePath(root, p.path))));
  ipcMain.handle('fs:write-absolute', ok((p) => files.writeAbsolute(p.path, p.content, root)));
  ipcMain.handle('fs:delete-absolute', ok((p) => files.removeAbsolute(p.path)));
  ipcMain.handle('fs:read-external', ok((p) => files.readExternal(p.path)));
  ipcMain.handle('fs:read-absolute', ok((p) => files.readAbsolute(p.path)));
  ipcMain.handle('fs:find', ok(needRoot((p) => files.find(root, p))));
  ipcMain.handle('fs:search', ok(needRoot((p) => files.search(root, p))));
  ipcMain.handle('fs:search-replace', ok(needRoot((p) => files.searchReplace(root, p))));

  // --- integrated terminal (node-pty; spawn cwd = project or scratch) ---
  const termCwd = async () => {
    const cwd = root || path.join(app.getPath('userData'), 'scratch');
    try {
      await fs.mkdir(cwd, { recursive: true });
    } catch {
      /* spawn reports real errors */
    }
    return cwd;
  };
  const termHooks = {
    onData: (id, data) => broadcast('term:data', { id, data }),
    onExit: (id, code, signal) => broadcast('term:exit', { id, code, signal }),
  };
  ipcMain.handle('term:create', ok(async (p = {}) => term.create(
    { shell: p.shell || undefined, cwd: await termCwd(), cols: p.cols || 80, rows: p.rows || 24 },
    termHooks,
  )));
  ipcMain.handle('term:write', ok((p = {}) => term.write(p.id, p.data ?? '')));
  ipcMain.handle('term:resize', ok((p = {}) => term.resize(p.id, p.cols, p.rows)));
  ipcMain.handle('term:kill', ok((p = {}) => term.kill(p.id)));
  ipcMain.handle('term:list', ok(() => term.list()));
  // Bolt (API client): main-process HTTP so CORS never applies.
  ipcMain.handle('api:send', ok((p = {}) => api.send(p)));
  ipcMain.handle('api:cancel', ok((p = {}) => api.cancel(p.reqId)));  ipcMain.handle('term:default-shell', ok(() => ({ shell: term.defaultShell(), label: term.shellLabel(term.defaultShell()) })));
  // Deterministic clipboard for the terminal (renderer clipboard API is
  // focus-gated; main-process electron.clipboard always works).
  ipcMain.handle('app:clip-read', ok(() => ({ text: clipboard.readText() })));
  ipcMain.handle('app:clip-write', ok((p = {}) => { clipboard.writeText(String(p.text ?? '')); return { ok: true }; }));
  // Retry a failed bundled-server boot (slow disks, AV locks). The renderer
  // banner offers this; success/error flow through the normal broadcasts.
  ipcMain.handle('app:retry-opencode', ok(async () => {
    const cwd = root || path.join(app.getPath('userData'), 'scratch');
    try {
      await fs.mkdir(cwd, { recursive: true });
    } catch {
      /* spawn reports real errors */
    }
    await restartServer(cwd, { onLog: (line) => console.log(line.trimEnd()) });
    broadcast('opencode:ready', { root });
    return { root };
  }));
  // --- notifications (Windows toast + taskbar badge/flash) ---------------
  // Renderer decides WHEN (agent edges + settings + focus); main owns the
  // OS surface. Badge count clears the moment the window regains focus.
  const noteLogo = path.join(DIST_DIR, 'barang-logo.png');
  ipcMain.handle('app:notify', ok((p = {}) => {
    const title = String(p.title || 'Barang').slice(0, 120);
    const body = String(p.body || '').slice(0, 300);
    const badge = p.badge !== false; // Settings > Notifications > taskbar badge
    try {
      const n = new Notification({
        title, body, silent: true,
        icon: existsSync(noteLogo) ? noteLogo : undefined,
      });
      n.on('click', () => {
        try {
          if (!win) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } catch {
          /* noop */
        }
      });
      n.show();
    } catch {
      /* headless/service session: no shell to toast — badge still applies */
    }
    if (badge) {
      notifCount++;
      try {
        app.setBadgeCount(notifCount);
      } catch {
        /* noop */
      }
      try {
        if (win && !win.isFocused()) win.flashFrame(true);
      } catch {
        /* noop */
      }
    }
    return { ok: true, count: notifCount };
  }));
  ipcMain.handle('app:clear-attention', ok(() => {
    clearAttention();
    return { ok: true };
  }));
  // Custom notification sound: user picks an audio file, we vault a copy in
  // userData (survives moves/renames of the original) and hand back a
  // file:// URL the sandboxed renderer can play directly.
  ipcMain.handle('app:pick-sound', ok(async () => {
    if (!win) throw new Error('Window not ready');
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose notification sound',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) throw new Error('cancelled');
    const src = picked.filePaths[0];
    const st = await fs.stat(src);
    if (st.size > 15 * 1024 * 1024) throw new Error('Sound file is too large (max 15MB)');
    const safe = path.basename(src).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'custom-sound';
    const dir = path.join(app.getPath('userData'), 'sounds');
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${safe}`);
    await fs.copyFile(src, dest);
    const fileUrl = 'file:///' + dest.replace(/\\/g, '/').split('/').map((s) => encodeURIComponent(s)).join('/');
    return { ok: true, id: path.basename(dest), name: path.basename(src), fileUrl };
  }));
  // Delete a vaulted custom sound (picked via app:pick-sound). The id is a
  // bare basename validated against the vault dir — no traversal possible.
  ipcMain.handle('app:remove-sound', ok(async (p = {}) => {
    const id = String(p.id || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) throw new Error('Bad sound id');
    const dir = path.join(app.getPath('userData'), 'sounds');
    const target = path.join(dir, id);
    if (path.dirname(target) !== dir) throw new Error('Bad sound id');
    await fs.rm(target, { force: true });
    return { ok: true, id };
  }));
  // Terminal link clicks: http(s) only, opened in the OS browser.
  ipcMain.handle('app:open-external', ok((p = {}) => {
    const url = String(p.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
    void shell.openExternal(url);
    return { ok: true };
  }));
  // --- source control (single channel; op dispatch, project-root cwd) ---
  // `cwd` override exists for the throwaway E2E repo only — the UI never
  // passes it (same trust level as the fs bridge either way).
  const gitCwd = () => root || path.join(app.getPath('userData'), 'scratch');
  const cw = (a) => (a && typeof a.cwd === 'string' && a.cwd ? a.cwd : gitCwd());
  const gitOps = {
    info: (a) => scm.info(cw(a)),
    diff: (a) => scm.fileDiff(cw(a), String(a.path || '')),
    'write-status': (a) => scm.writeStatus(cw(a), [].concat(a.paths ?? [])),
    stage: (a) => scm.stage(cw(a), [].concat(a.paths ?? [])),
    unstage: (a) => scm.unstage(cw(a), [].concat(a.paths ?? [])),
    discard: (a) => scm.discard(cw(a), [].concat(a.paths ?? [])),
    commit: (a) => scm.commit(cw(a), a.message, a.amend === true, a.signoff === true),
    'commit-all': (a) => scm.commitAll(cw(a), a.message, a.signoff === true),
    'undo-commit': (a) => scm.undoCommit(cw(a)),
    'resolve-conflict': (a) => scm.resolveConflict(cw(a), String(a.path || ''), String(a.side || '')),
    'stage-ranges': (a) => scm.stageRanges(cw(a), String(a.path || ''), a.ranges ?? []),
    branches: (a) => scm.branches(cw(a)),
    checkout: (a) => scm.checkout(cw(a), String(a.name || '')),
    'create-branch': (a) => scm.createBranch(cw(a), String(a.name || '')),
    fetch: (a) => scm.fetchAll(cw(a)),
    pull: (a) => scm.pull(cw(a)),
    push: (a) => scm.push(cw(a)),
    sync: (a) => scm.sync(cw(a)),
    'stash-list': (a) => scm.stashList(cw(a)),
    'stash-push': (a) => scm.stashPush(cw(a), a.message),
    'stash-pop': (a) => scm.stashPop(cw(a)),
    'stash-drop': (a) => scm.stashDrop(cw(a)),
    log: (a) => scm.log(cw(a), a.n),
    init: (a) => scm.init(cw(a)),
    config: (a) => scm.setConfig(cw(a), String(a.key || ''), String(a.value || '')),
  };
  ipcMain.handle('git:run', ok(async (p = {}) => {
    const fn = gitOps[p.op];
    if (!fn) throw new Error(`Unknown git op: ${p.op}`);
    return fn(p.args ?? {});
  }));

  ipcMain.handle('oc:call', async (_ev, p = {}) => {
    try {
      const res = await ocCall(p.path, { method: p.method || 'GET', body: p.body, timeoutMs: p.timeoutMs });
      return { ok: true, status: res.status, text: res.text };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('app:state', () => ({
    root,
    recent: recents,
    restore: restoreProject,
    opencode: opencodeState(),
    versions: { app: app.getVersion(), electron: process.versions.electron },
  }));
  ipcMain.handle('app:open-folder', async () => {
    const res = await handleOpenFolder();
    return res ? { ok: true, data: res } : { ok: false, error: 'cancelled' };
  });
  ipcMain.handle('app:open-path', ok((p) => openPath(p.path)));
  // Default Vibe folder (app-managed, always writable): created on demand.
  ipcMain.handle('app:default-folder', ok(async () => {
    const dir = path.join(app.getPath('userData'), 'Default');
    await fs.mkdir(dir, { recursive: true });
    return { root: dir };
  }));
  ipcMain.handle('app:set-restore', async (_ev, p = {}) => {
    restoreProject = p.restore === true;
    await saveState();
    return { ok: true, data: { restore: restoreProject } };
  });
  ipcMain.handle('app:check-updates', async () => {
    try {
      return { ok: true, data: await checkForUpdates() };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('app:download-update', async () => {
    try {
      return { ok: true, data: { path: await downloadUpdate() } };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('app:apply-update', async (_ev, p = {}) => {
    // Dev builds can't self-update (no packaged exe to replace into).
    if (!app.isPackaged) return { ok: false, error: 'dev' };
    const target = String(p.path || '');
    if (!/Barang-.*-win\.exe$/i.test(path.basename(target))) return { ok: false, error: 'not a Barang update file' };
    const st = await fs.stat(target).catch(() => null);
    if (!st || !st.size) return { ok: false, error: 'download missing — fetch it again' };
    // Optional "replace my original file": the new app copies the download
    // over the user's exe once this process lets go (marker file carries
    // the intent — argv doesn't reliably survive the portable wrapper).
    const tempDir = app.getPath('temp');
    const wantReplace = String(p.replace || '');
    if (wantReplace) {
      try {
        updater.validateReplaceArgs(target, wantReplace);
        await updater.writeReplaceMarker(tempDir, target, wantReplace);
      } catch (e) {
        await updater.clearReplaceMarker(tempDir);
        return { ok: false, error: e?.message || String(e) };
      }
    } else {
      await updater.clearReplaceMarker(tempDir);
    }
    try {
      const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
    } catch (e) {
      await updater.clearReplaceMarker(tempDir);
      return { ok: false, error: e?.message || String(e) };
    }
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  });
  // MCP config files: raw read/write with validation + rotating backup.
  // Scopes: 'managed' (Barang's global file, merged by opencode over every
  // other layer) and 'project' (<root>/opencode.json). The renderer owns all
  // merging/validation (pure, unit-tested); main only touches bytes.
  ipcMain.handle('mcp:config', async (_ev, p = {}) => {
    try {
      const scope = p.scope === 'project' ? 'project' : 'managed';
      if (p.action === 'read') {
        let fp;
        if (scope === 'project') {
          if (!root) throw new Error('No folder open');
          fp = path.join(root, 'opencode.json');
        } else {
          fp = managedMcpPath();
          await ensureManagedMcp();
        }
        const text = await fs.readFile(fp, 'utf8').catch(() => '');
        return { ok: true, data: { path: fp, text, exists: text !== '' } };
      }
      if (p.action === 'write') {
        const text = String(p.text ?? '');
        JSON.parse(text); // strict-JSON validation before touching disk
        let fp;
        if (scope === 'project') {
          if (!root) throw new Error('No folder open');
          fp = path.join(root, 'opencode.json');
          await fs.mkdir(path.dirname(fp), { recursive: true }).catch(() => {});
        } else {
          fp = managedMcpPath();
          await ensureManagedMcp();
        }
        const prev = await fs.readFile(fp, 'utf8').catch(() => null);
        if (prev !== null && prev !== text) {
          await fs.writeFile(fp + '.bak', prev).catch(() => {});
        }
        await fs.writeFile(fp, text);
        return { ok: true, data: { path: fp } };
      }
      throw new Error('Unknown mcp:config action');
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
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
  ipcMain.handle('app:save-dialog', async (_ev, p = {}) => {
    // Untitled Save-As: native dialog, explicit user consent for the path.
    const picked = await dialog.showSaveDialog(win ?? undefined, {
      defaultPath: p.defaultPath || root || undefined,
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'Text', extensions: ['txt', 'md'] },
      ],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' };
    return { ok: true, data: { path: picked.filePath } };
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
  await check('command-list', async () => {
    const r = await ocCall('/command');
    const list = JSON.parse(r.text);
    const arr = Array.isArray(list) ? list : list.value;
    if (!Array.isArray(arr) || arr.some((c) => !c || typeof c.name !== 'string' || !c.name)) {
      throw new Error('bad command list');
    }
    return `${arr.length} commands`;
  });
  await check('command-shape', async () => {
    // Empty-payload command must fail VALIDATION (400), proving the route is
    // live without running anything side-effectful.
    const c = await ocCall('/session', { method: 'POST', body: { title: 'barang cmd probe' } });
    const s = JSON.parse(c.text);
    if (!s.id) throw new Error('no session id');
    try {
      const r = await ocCall(`/session/${s.id}/command`, { method: 'POST', body: {} });
      if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${r.text.slice(0, 120)}`);
      return '400 as expected';
    } finally {
      await ocCall(`/session/${s.id}`, { method: 'DELETE' });
    }
  });
  await check('update-shape', async () => {
    const i = await checkForUpdates();
    if (typeof i.update !== 'boolean' || i.current !== app.getVersion()) {
      throw new Error('bad update payload');
    }
    // A 4xx here means OUR endpoint is wrong (offline/DNS/timeout passes
    // vacuously — the sandbox may have no network).
    if (i.error && /HTTP 4/.test(i.error)) throw new Error('update endpoint broken: ' + i.error);
    return `update=${i.update} current=${i.current}`;
  });
  await check('term-echo', async () => {
    // Real PTY roundtrip: spawn the default shell, echo a marker, kill.
    const cwd = root || path.join(app.getPath('userData'), 'scratch');
    let out = '';
    let exited = null;
    const t = term.create({ cwd, cols: 80, rows: 24 }, {
      onData: (_id, data) => { out += data; },
      onExit: (_id, code) => { exited = code; },
    });
    if (!t.id) throw new Error('no terminal id');
    term.write(t.id, 'echo barang-pty-ping-8675309\r');
    const deadline = Date.now() + 15000;
    while (!out.includes('barang-pty-ping-8675309') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    term.kill(t.id);
    if (!out.includes('barang-pty-ping-8675309')) throw new Error(`no echo in PTY output (${out.length} chars)`);
    return `echo ok, shell=${term.shellLabel(t.shell)}`;
  });
  await check('git-status', async () => {    // Barang's own folder is a git repo — status must resolve against it.
    const cwd = root || path.join(app.getPath('userData'), 'scratch');
    const i = await scm.info(cwd);
    if (!i.gitFound) throw new Error('git binary not found');
    if (!i.isRepo) {
      let why = '';
      try {
        await scm.branches(cwd);
      } catch (e) {
        why = ' branches-err: ' + String(e?.message || e).split('\n')[0].slice(0, 200);
      }
      throw new Error('expected a git repo here.' + why);
    }
    if (!i.branch) throw new Error('no branch resolved');
    return `${i.branch} +${(i.staged ?? []).length} ~${(i.changes ?? []).length}`;
  });
  await check('search-speed', async () => {
    // Project search must complete (ripgrep path when bundled, walker
    // fallback otherwise) — guards the stdin-hang and exit-1 regressions.
    const cwd = root || path.join(app.getPath('userData'), 'scratch');
    const t0 = Date.now();
    const r = await files.searchReplace(cwd, { q: 'const', dryRun: true });
    const ms = Date.now() - t0;
    if (r.totalFiles < 5) throw new Error(`suspiciously few hits (${r.totalFiles})`);
    return `${r.totalFiles} files in ${ms}ms`;
  });
  await check('git-cycle', async () => {
    // Full lifecycle in a THROWAWAY repo under temp (never user code):
    // init/config/commit/stage/unstage/branches/stash/commit-all/
    // stage-ranges/discard/conflict-resolve/undo-commit.
    const dir = path.join(app.getPath('temp'), `barang-git-cycle-${process.pid}`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const W = (n, c) => fs.writeFile(path.join(dir, n), c, 'utf8');
    const R = (n) => fs.readFile(path.join(dir, n), 'utf8');
    const step = async (name, fn, want) => {
      const r = await fn();
      if (!want(r)) throw new Error(`step ${name} failed: ${JSON.stringify(r).slice(0, 160)}`);
    };
    const has = (list, p) => (list ?? []).some((f) => (f.path ?? f) === p);
    try {
      await scm.init(dir);
      await scm.setConfig(dir, 'user.name', 'barang-test');
      await scm.setConfig(dir, 'user.email', 'barang-test@example.com');
      await step('init', () => scm.info(dir), (r) => r.isRepo === true && !!r.branch);
      // Critical containment: a bare subfolder must NEVER see the parent's
      // .git (no status, and mutating ops refuse instead of touching it).
      await step('subfolder-contained', async () => {
        const sub = path.join(dir, 'sub');
        await fs.mkdir(sub, { recursive: true });
        const i = await scm.info(sub);
        let threw = false;
        try {
          await scm.branches(sub);
        } catch {
          threw = true;
        }
        return { childRepo: i.isRepo, threw };
      }, (r) => r.childRepo === false && r.threw === true);
      await step('parent-still-repo', () => scm.info(dir), (r) => r.isRepo === true);
      const main = (await scm.info(dir)).branch;
      await W('a.txt', 'one\ntwo\n');
      await step('stage', () => scm.stage(dir, ['a.txt']).then(() => scm.info(dir)), (r) => has(r.staged, 'a.txt'));
      await step('commit', () => scm.commit(dir, 'first').then(() => scm.log(dir, 5)), (r) => r.all.length === 1);
      await W('a.txt', 'one\nTWO\n');
      await W('b.txt', 'new\n');
      await step('status2', () => scm.info(dir), (r) => (r.changes ?? []).length === 2);
      await step('unstage', () => scm.stage(dir, ['a.txt']).then(() => scm.unstage(dir, ['a.txt'])).then(() => scm.info(dir)),
        (r) => (r.staged ?? []).length === 0 && has(r.changes, 'a.txt'));
      await step('branch', () => scm.createBranch(dir, 'feat').then(() => scm.branches(dir)),
        (r) => r.current === 'feat' && r.all.includes('feat'));
      await step('checkout', () => scm.checkout(dir, main).then(() => scm.branches(dir)), (r) => r.current === main);
      await step('stash', () => scm.stashPush(dir, 'wip').then(() => scm.stashList(dir)), (r) => r.all.length === 1);
      await step('stash-pop', () => scm.stashPop(dir).then(() => scm.info(dir)), (r) => has(r.changes, 'a.txt'));
      await step('commit-all', () => scm.commitAll(dir, 'second').then(() => scm.log(dir, 5)), (r) => r.all.length === 2);
      await step('commit-all-untracked-stays', () => scm.info(dir), (r) => has(r.changes, 'b.txt'));
      await W('a.txt', 'ONE\nTWO\nTHREE\n');
      await step('stage-ranges', () => scm.stageRanges(dir, 'a.txt', [{ start: 3, end: 3 }]).then(() => scm.info(dir)),
        (r) => has(r.staged, 'a.txt') && has(r.changes, 'a.txt'));
      await scm.unstage(dir, ['a.txt']);
      await step('discard', () => scm.discard(dir, ['a.txt']).then(() => scm.info(dir)), (r) => !has(r.changes, 'a.txt'));
      const markers = 'top\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> branch\nbottom\n';
      await W('c.txt', markers);
      await step('resolve-ours', () => scm.resolveConflict(dir, 'c.txt', 'ours').then(() => R('c.txt')),
        (t) => t.includes('A') && !t.includes('B') && !t.includes('<<<<<<<'));
      await W('c.txt', markers);
      await step('resolve-both', () => scm.resolveConflict(dir, 'c.txt', 'both').then(() => R('c.txt')),
        (t) => t.includes('A') && t.includes('B'));
      await step('undo-commit', () => scm.undoCommit(dir).then(() => scm.log(dir, 5)), (r) => r.all.length === 1);
      return '18 steps ok';
    } finally {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
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
  // Bolt E2E runs against a LOCAL stub server (no internet needed): echo,
  // 404, and plain-text endpoints with an artificial delay option.
  const boltSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 200000) req.destroy();
    });
    req.on('end', () => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname === '/notfound') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      if (u.pathname === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('plain-response-body');
        return;
      }
      if (u.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          try {
            res.end(JSON.stringify({ slow: true }));
          } catch {
            /* client went away (cancel test) */
          }
        }, 8000);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-bolt-probe': 'yes' });
      res.end(JSON.stringify({
        method: req.method,
        query: Object.fromEntries(u.searchParams),
        mirror: req.headers['x-mirror'] ?? null,
        body,
      }));
    });
  });
  await new Promise((r) => boltSrv.listen(0, '127.0.0.1', r));
  const boltPort = boltSrv.address().port;
  const probe = await w.webContents
    .executeJavaScript(
      `(async () => {
        const q = (s) => document.querySelector(s);
        const qa = (s) => [...document.querySelectorAll(s)];
        // Explorer context menu: synthetic right-click must open a populated
        // menu, and Escape must close it.
        let ctxMenu = false, ctxItems = 0, ctxClosed = false, ctxCopyPaths = false, ctxReveal = false;
        try {
          const lbl = qa('.tree-label')[0];
          if (lbl) {
            const r = lbl.getBoundingClientRect();
            lbl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
            await new Promise((rr) => setTimeout(rr, 400));
            const m = q('.ctx-menu');
            ctxMenu = !!m;
            ctxItems = m ? m.querySelectorAll('.ctx-item').length : 0;
            const t = m ? (m.textContent || '') : '';
            ctxCopyPaths = t.includes('Copy Path') && t.includes('Copy Relative Path');
            ctxReveal = t.includes('Reveal in File Explorer');
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
        // Hot project switch: openPath must swap the explorer WITHOUT a page
        // reload (evaluate surviving proves it) and fast (<5s, not ~15s+).
        let hotSwitch = 'skip', switchMs = -1;
        try {
          const tmp = 'C:\\\\Users\\\\Achi\\\\AppData\\\\Local\\\\Temp\\\\opencode';
          const home = 'C:\\\\Users\\\\Achi\\\\Desktop\\\\Barang';
          const t0 = performance.now();
          await window.barang.app.openPath(tmp);
          for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 200));
            if (document.querySelector('.side-title')?.textContent === 'opencode') {
              switchMs = Math.round(performance.now() - t0);
              break;
            }
          }
          await window.barang.app.openPath(home);
          await new Promise((r) => setTimeout(r, 2000));
          const back = document.querySelector('.side-title')?.textContent;
          hotSwitch = switchMs >= 0 && switchMs < 5000 && back === 'Barang' ? 'ok' : 'slow-or-wrong:' + switchMs + '/' + back;
        } catch (e) { hotSwitch = 'error:' + (e.message || e); }
        // Explorer rail: collapse button rails the sidebar, rail button restores.
        // Monaco scrollbars: slim (<=10px) once any editor has booted.
        let rail = 'skip', scrollSlim = 'skip';
        try {
          const col = q('.side-header .side-collapse');
          if (col) {
            col.click();
            await new Promise((r) => setTimeout(r, 300));
            const railed = q('.sidebar').classList.contains('rail');
            const exp = q('.sidebar .rail-btn');
            if (exp) exp.click();
            await new Promise((r) => setTimeout(r, 300));
            const back = !q('.sidebar').classList.contains('rail');
            // Rail button must be invisible again once restored (specificity trap).
            const btnHidden = getComputedStyle(q('.sidebar .rail-btn')).display === 'none';
            rail = railed && back && btnHidden ? 'ok' : 'broken';
          }
        } catch { rail = 'error'; }
        try {
          const sb = document.querySelector('.monaco-editor .scrollbar.vertical');
          if (sb) {
            const w = parseFloat(sb.style.width) || parseFloat(getComputedStyle(sb).width);
            scrollSlim = w <= 10 ? 'ok' : 'wide:' + w;
          }
        } catch { scrollSlim = 'error'; }
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
        // NOTE: no Escape dispatch here — the Settings modal is open by now
        // and correctly closes on Escape; stray dispatches kill it.
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
        // Retried: modal open raced flakily exactly once, so tolerate latency.
        const btn = q('.settings-btn');
        let settingsTries = 0, overlaySeen = false, openedAtOnce = false;
        if (btn) {
          for (let i = 0; i < 6 && !q('.settings-overlay'); i++) {
            settingsTries++;
            try { btn.click(); } catch (e) { overlaySeen = overlaySeen; }
            await new Promise((rr) => setTimeout(rr, 500));
            if (q('.settings-overlay')) overlaySeen = true;
          }
          openedAtOnce = !!q('.settings-overlay');
        }
        // fs full roundtrip over the REAL IPC chain (temp dir in root).
        let fsRoundtrip = 'skip';
        const modalTrail = [];
        const modalAlive = (tag) => {
          modalTrail.push(tag + '=' + (!!document.querySelector('.settings-overlay')));
        };
        modalAlive('after-open');
        try {
          await window.barang.fs.write('.barang-smoke-ui/ping.txt', 'pong');
          const r = await window.barang.fs.rename('.barang-smoke-ui/ping.txt', '.barang-smoke-ui/pong.txt');
          const f = await window.barang.fs.read('.barang-smoke-ui/pong.txt');
          await window.barang.fs.mkdir('.barang-smoke-ui/sub');
          await window.barang.fs.write('.barang-smoke-ui/sub/x.txt', 'x');
          const okSoFar = r.path === '.barang-smoke-ui/pong.txt' && f.content === 'pong';
          await window.barang.fs.remove('.barang-smoke-ui');
          let gone = false;
          try { await window.barang.fs.read('.barang-smoke-ui/pong.txt'); } catch { gone = true; }
          fsRoundtrip = okSoFar && gone ? 'ok' : 'mismatch';
        } catch (e) {
          fsRoundtrip = 'error: ' + (e.message || e);
        }
        try { await window.barang.fs.remove('.barang-smoke-ui'); } catch {}
        // New-file-via-prompt: the exact UI path users take (button, type, Enter).
        modalAlive('after-fs');
        // Toolbar create targets the FOCUSED entry (VSCode); anchor focus on
        // a root file first so the new file lands at root, not in whatever
        // folder an earlier step expanded.
        let createFile = 'skip';
        try {
          const rootFile = [...document.querySelectorAll('.tree-label')].find((b) => !(b.title || '').includes('/') && !b.querySelector('.tw'));
          if (rootFile) {
            rootFile.click();
            await new Promise((rr) => setTimeout(rr, 400));
          }
          const btn = document.querySelector('.side-header [title="New file"]');
          if (btn) {
            btn.click();
            await new Promise((r) => setTimeout(r, 500));
            const inp = document.querySelector('.tree-prompt-input');
            if (!inp) { createFile = 'no-prompt'; }
            else {
              inp.focus();
              inp.value = '.barang-smoke-ui/probe-file.txt';
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 2500));
              try {
                const f = await window.barang.fs.read('.barang-smoke-ui/probe-file.txt');
                createFile = f.content === '' ? 'ok' : 'content-mismatch';
              } catch (e) { createFile = 'missing:' + (e.message || e); }
            }
          }
        } catch (e) { createFile = 'error: ' + (e.message || e); }
        modalAlive('after-create');
        // Rename-via-context-menu: expand the dir, right-click row, Rename item, retype, Enter.
        let renameFile = 'skip', renamePlaced = false;
        try {
          const labels = [...document.querySelectorAll('.tree-label')];
          const dirRow = labels.find((b) => (b.title || '') === '.barang-smoke-ui');
          if (dirRow) {
            dirRow.click();
            await new Promise((rr) => setTimeout(rr, 800));
          }
          const target = [...document.querySelectorAll('.tree-label')].find((b) => (b.title || '').endsWith('probe-file.txt'));
          if (!target) { renameFile = 'no-row'; }
          else {
            const r = target.getBoundingClientRect();
            target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
            await new Promise((rr) => setTimeout(rr, 400));
            const item = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => (b.textContent || '').trim() === 'Rename');
            if (!item) { renameFile = 'no-item'; }
            else {
              item.click();
              // Fast poll + immediate focus: the fresh prompt self-dismisses
              // on blur (~150ms), and headless focus is racy — catching it
              // early and focusing anchors it (same as a real user click).
              let inp = null;
              for (let i = 0; i < 40 && !inp; i++) {
                await new Promise((rr) => setTimeout(rr, 100));
                renamePlaced = renamePlaced || !!q('.tree-sub .tree-prompt');
                inp = document.querySelector('.tree-prompt-input');
                if (inp) {
                  try {
                    inp.focus();
                  } catch {}
                }
              }
              if (!inp) { renameFile = 'no-prompt'; }
              else {
                inp.focus();
                // VSCode parity: rename takes a bare name, resolved against
                // the entry's own directory.
                inp.value = 'probe-renamed.txt';
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                await new Promise((rr) => setTimeout(rr, 2500));
                try {
                  const f = await window.barang.fs.read('.barang-smoke-ui/probe-renamed.txt');
                  renameFile = 'ok';
                } catch (e) { renameFile = 'missing:' + (e.message || e); }
              }
            }
          }
          // NOTE: no Escape dispatch here — the Settings modal is open by now
          // and correctly closes on Escape; stray dispatches kill it.
        } catch (e) { renameFile = 'error: ' + (e.message || e); }
        // Focus-relative creation (VSCode semantics): focus a dir, hit the
        // toolbar New File, type a BARE name — it must land inside the dir.
        let focusCreate = 'skip';
        try {
          const dirLbl = [...document.querySelectorAll('.tree-label')].find((b) => (b.title || '') === '.barang-smoke-ui');
          if (!dirLbl) { focusCreate = 'no-dirrow'; }
          else {
            dirLbl.click();
            await new Promise((rr) => setTimeout(rr, 600));
            const nf = document.querySelector('.side-header [title="New file"]');
            if (!nf) { focusCreate = 'no-button'; }
            else {
              nf.click();
              await new Promise((rr) => setTimeout(rr, 600));
              const inp = document.querySelector('.tree-prompt-input');
              if (!inp) { focusCreate = 'no-prompt'; }
              else {
                inp.focus();
                inp.value = 'focus-file.txt';
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                await new Promise((rr) => setTimeout(rr, 2500));
                try {
                  await window.barang.fs.read('.barang-smoke-ui/focus-file.txt');
                  focusCreate = 'ok';
                } catch (e) { focusCreate = 'missing:' + (e.message || e); }
              }
            }
          }
        } catch (e) { focusCreate = 'error: ' + (e.message || e); }
        // Untitled tabs (Ctrl+N) + close (Ctrl+W). Skipped if Monaco never booted.
        // Closes ALL untitled tabs: a boot-restored scratch from a previous
        // run's tab session may already be open (by design).
        let untitled = 'skip';
        try {
          if (!document.querySelector('.monaco-editor')) { untitled = 'skip-no-monaco'; }
          else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
            await new Promise((rr) => setTimeout(rr, 800));
            const tab = [...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').includes('Untitled'));
            if (!tab) { untitled = 'no-tab'; }
            else {
              for (let c = 0; c < 8; c++) {
                const anyUntitled = [...document.querySelectorAll('.tabs .tab')].some((b) => (b.textContent || '').includes('Untitled'));
                if (!anyUntitled) break;
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
                await new Promise((rr) => setTimeout(rr, 800));
              }
              const gone = ![...document.querySelectorAll('.tabs .tab')].some((b) => (b.textContent || '').includes('Untitled'));
              untitled = gone ? 'ok' : 'not-closed';
            }
          }
        } catch (e) { untitled = 'error: ' + (e.message || e); }
        // Delete key: focus the DIR row itself (clicking a file would open
        // it in Monaco and steal focus, correctly skipping), press Delete,
        // confirm in the themed modal (never a native dialog).
        let delKey = 'skip';
        try {
          await window.barang.fs.write('.barang-smoke-ui/del-me.txt', 'x');
          const refresher = document.querySelector('.side-header [title="Refresh"]');
          if (refresher) refresher.click();
          await new Promise((rr) => setTimeout(rr, 1000));
          const dirRow = [...document.querySelectorAll('.tree-label')].find((b) => (b.title || '') === '.barang-smoke-ui');
          if (!dirRow) { delKey = 'no-row'; }
          else {
            dirRow.click();
            await new Promise((rr) => setTimeout(rr, 400));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
            await new Promise((rr) => setTimeout(rr, 600));
            const okBtn = [...document.querySelectorAll('.confirm-modal button')].find((b) => (b.textContent || '').trim() === 'Delete');
            if (!okBtn) { delKey = 'no-confirm'; }
            else {
              okBtn.click();
              await new Promise((rr) => setTimeout(rr, 1500));
              try {
                await window.barang.fs.read('.barang-smoke-ui/del-me.txt');
                delKey = 'not-deleted';
              } catch { delKey = 'ok'; }
            }
          }
        } catch (e) { delKey = 'error: ' + (e.message || e); }
        modalAlive('after-rename');
        try { await window.barang.fs.remove('.barang-smoke-ui'); } catch {}
        return JSON.stringify({
          fsRoundtrip,
          brand: q('.brand-name')?.textContent || null,
          brandImg: !!q('.brand img.brand-logo'),
          banner: !!q('.oc-banner:not(.hidden)'),
          hasEditor: !!q('.editor-host'),
          hasAgent: !!q('.agent-panel'),
          gutters: qa('.gutter-v').length,
          panelsVisible: !q('.sidebar.collapsed') && !q('.agent-wrap.collapsed'),
          welcomeHidden: !!q('.welcome.hidden'),
          openSplit: !!q('.top-split') && !!q('.top-split .top-split-chev'),
          icons: qa('.ic svg').length,
          selects: qa('.agent-panel select').length,
          noSessionLabel: !q('.agent-panel .agent-section-label'),
          headerShadow: (() => {
            const s = q('.agent-panel .sess-section');
            return s ? getComputedStyle(s).boxShadow !== 'none' : false;
          })(),
          updateBtn: !!q('.topbar .update-btn'),
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
          ctxMenu, ctxItems, ctxClosed, ctxCopyPaths, ctxReveal,
          diffTab, collapse, statColors, dotAlign, dotDelta, treeBad, rail, scrollSlim, createFile, renameFile, renamePlaced, openedAtOnce,
          modalTrail: modalTrail.join(','), hotSwitch, switchMs, focusCreate, untitled, delKey,
          aboutVer: (q('.about-ver')?.textContent || '').trim(),
          reasoningShown: qa('.tool-row summary').filter((s) => (s.textContent || '').trim() === 'Reasoning').length,
          stepRows: qa('.tool-row summary').filter((s) => /^step[\\s-_]*(start|finish)?/i.test((s.textContent || '').trim())).length,
          revertBtns: qa('.msg-action').length,
          headings: qa('.msg-md h1,.msg-md h2,.msg-md h3,.msg-md h4').length,
          toolRows: qa('.tool-row').length,
          emptyRows: qa('.tool-row').filter((d) => { const b = d.querySelector('.tool-body'); return !b || !b.textContent.trim(); }).length,
          // Our chrome must be emoji-free; user/agent message CONTENT is
          // exempt (live data may contain anything).
          emoji: (() => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll('.chat-list, .msg').forEach((n) => n.remove());
            return (clone.innerText.match(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u) || []).length;
          })(),
        });
      })()`,
    )
    .catch((e) => `EVAL-FAIL: ${e.message}`);
  console.log('[smoke-ui] dom:', probe);
  console.log('[smoke-ui] console-errors:', errors.length ? errors.slice(0, 10) : 'none');
  const dom = JSON.parse(probe.startsWith('{') ? probe : '{}');
  let pass = dom.brand === 'Barang' && dom.brandImg === true && dom.hasEditor && dom.hasAgent &&
    dom.gutters === 2 && dom.panelsVisible === true && dom.welcomeHidden === true && dom.openSplit === true && dom.updateBtn === true && dom.noSessionLabel === true && dom.headerShadow === true &&     dom.icons >= 8 && dom.selects === 3 && dom.emoji === 0 &&
    dom.emptyRows === 0 && dom.settingsBtn === true && dom.settingsModal === true &&
    dom.reasoningShown === 0 && dom.stepRows === 0 &&
    dom.ctxMenu === true && dom.ctxItems >= 4 && dom.ctxClosed === true && dom.ctxCopyPaths === true && dom.ctxReveal === true &&
    dom.fsRoundtrip === 'ok' && dom.changesSec === true &&
    dom.attachBtn === true && dom.modelMini === true && dom.sendIcon === true &&
    (dom.brandAlign.s === 'ok' || dom.brandAlign.s === 'skip') &&
    (dom.diffTab === 'ok' || dom.diffTab === 'ok-patch' || dom.diffTab === 'skip') &&
    (dom.collapse === 'ok' || dom.collapse === 'skip') &&
    (dom.statColors === 'ok' || dom.statColors === 'skip') &&
    (dom.dotAlign === 'ok' || dom.dotAlign === 'skip') &&
    dom.treeBad === 0 &&
    (dom.rail === 'ok' || dom.rail === 'skip') &&
    (dom.scrollSlim === 'ok' || dom.scrollSlim === 'skip') &&
    (dom.createFile === 'ok' || dom.createFile === 'skip') &&
    (dom.renameFile === 'ok' || dom.renameFile === 'skip') &&
    (dom.focusCreate === 'ok' || dom.focusCreate === 'skip') &&
    (dom.untitled === 'ok' || dom.untitled === 'skip' || dom.untitled === 'skip-no-monaco') &&
    (dom.delKey === 'ok' || dom.delKey === 'skip') &&
    (dom.renameFile === 'skip' || dom.renamePlaced === true) &&
    (typeof dom.hotSwitch === 'string' && (dom.hotSwitch === 'ok' || dom.hotSwitch === 'skip')) &&
    dom.aboutVer.length > 3;
  console.log(`[smoke-ui] fs-ipc-roundtrip: ${dom.fsRoundtrip}`);
  console.log(`[smoke-ui] composer: attach=${dom.attachBtn} model=${dom.modelMini} sendIcon=${dom.sendIcon} brandAlign=${dom.brandAlign.s} (${typeof dom.brandAlign.d === 'number' ? dom.brandAlign.d.toFixed(2) : dom.brandAlign.d}px)`);
  console.log(`[smoke-ui] ctx-menu: ${dom.ctxMenu} (${dom.ctxItems} items, esc-closes: ${dom.ctxClosed})`);
  console.log(`[smoke-ui] diff-review: ${dom.diffTab}, collapse: ${dom.collapse}, stat-colors: ${dom.statColors}`);
  console.log(`[smoke-ui] rail: ${dom.rail}, scroll-slim: ${dom.scrollSlim}, create-file: ${dom.createFile}, rename: ${dom.renameFile}, in-place: ${dom.renamePlaced}, focus-create: ${dom.focusCreate}, untitled: ${dom.untitled}, delkey: ${dom.delKey}, about: ${dom.aboutVer}`);
  console.log(`[smoke-ui] hot-switch: ${dom.hotSwitch} (${dom.switchMs}ms)`);
  console.log(`[smoke-ui] settings-opened-at-once: ${dom.openedAtOnce}, trail: ${dom.modalTrail}`);
  console.log(`[smoke-ui] dot-align: ${dom.dotAlign} (max delta ${typeof dom.dotDelta === 'number' ? dom.dotDelta.toFixed(2) : dom.dotDelta}px)`);
  console.log(`[smoke-ui] tree-nesting-violations: ${dom.treeBad}`);
  console.log(`[smoke-ui] reasoning-shown: ${dom.reasoningShown}, step-rows: ${dom.stepRows}, revert-buttons: ${dom.revertBtns}`);
  if (dom.toolRows > 0) console.log(`[smoke-ui] tool-rows: ${dom.toolRows}, headings: ${dom.headings}`);
  console.log(`[smoke-ui] default-model: ${dom.defaultModel === '' ? '(auto)' : dom.defaultModel}`);
  if (dom.emptySamples?.length) console.log('[smoke-ui] empty-samples:', JSON.stringify(dom.emptySamples, null, 1));
  // Trusted-input repro: real click into the new-file prompt + physical
  // Enter via sendInputEvent (synthetic dispatchEvent can mask focus bugs).
  // Single-click focus contract first: opening a file from the tree must NOT
  // move focus into Monaco (otherwise tree keys like Delete go nowhere).
  let singleClickFocus = 'skip';
  try {
    singleClickFocus = await w.webContents.executeJavaScript(`(async () => {
      const frow = [...document.querySelectorAll('.tree-label')].find((b) => (b.title || '').endsWith('.json') && !b.querySelector('.tw'));
      if (!frow) return 'skip-no-row';
      frow.click();
      await new Promise((r) => setTimeout(r, 800));
      const inMonaco = !!document.querySelector('.monaco-editor')?.contains(document.activeElement);
      return inMonaco ? 'steals-focus' : 'ok';
    })()`);
  } catch (e) { singleClickFocus = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] single-click-focus: ' + singleClickFocus);
  pass = pass && (singleClickFocus === 'ok' || singleClickFocus === 'skip-no-row');
  // Drag-drop open: dropping a project file must open it as a tab.
  let dropProbe = 'skip';
  try {
    dropProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.dropPaths !== 'function') return 'no-drop-fn';
      try { await window.barang.fs.write('drop-probe.txt', 'drop me'); } catch (e) { return 'write-fail'; }
      await u.dropPaths(['drop-probe.txt'], 1);
      await new Promise((r) => setTimeout(r, 900));
      const tab = document.querySelector('.tab[data-path="drop-probe.txt"]');
      if (!tab) return 'tab-not-open';
      // Tab menu must offer both reveals (tree + OS file manager).
      const tr = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: tr.left + 8, clientY: tr.top + 8 }));
      await new Promise((r) => setTimeout(r, 400));
      const m = document.querySelector('.ctx-menu');
      const mt = m ? (m.textContent || '') : '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      if (!m || !mt.includes('Reveal in Explorer') || !mt.includes('Reveal in File Explorer')) {
        return 'tab-menu-bad:' + mt.slice(0, 120);
      }
      if (typeof u.closeTab === 'function') await u.closeTab('drop-probe.txt');
      try { await window.barang.fs.remove('drop-probe.txt'); } catch {}
      return 'ok';
    })()`);
  } catch (e) { dropProbe = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] drop-open: ' + dropProbe);
  pass = pass && dropProbe === 'ok';
  // Detached tabs: an absolute path OUTSIDE the project must open as a tab
  // (the old code refused these), and save must write it back in place.
  let dropOutside = 'skip';
  const dropTmp = path.join(app.getPath('temp'), 'barang-drop-outside.txt');
  try {
    await fs.writeFile(dropTmp, 'outside-1', 'utf8');
    const fwd = dropTmp.split(path.sep).join('/');
    dropOutside = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.dropPaths !== 'function') return 'no-drop-fn';
      // Earlier assertions leave the settings modal open — its overlay
      // would swallow the trusted clicks below.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      await u.dropPaths(['${fwd}'], 1);
      await new Promise((r) => setTimeout(r, 1200));
      const tab = document.querySelector('.tab[data-path="${fwd}"]');
      if (!tab) return 'tab-not-open';
      const name = tab.querySelector('.tab-name')?.textContent || '';
      if (name !== 'barang-drop-outside.txt') return 'bad-name:' + name;
      // Presence is not enough (a hidden strip still matches): the tab
      // must actually be visible.
      if (document.querySelector('.editor-cols.hidden')) return 'cols-hidden';
      if (tab.getBoundingClientRect().width === 0) return 'tab-zero-width';
      const ed = document.querySelector('.editor-host .monaco-editor');
      if (!ed) return 'no-monaco';
      const r = ed.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`);
    if (dropOutside.startsWith('{')) {
      // Trusted-type into the detached tab (proves dirty tracking works on
      // detached models), then Ctrl+S through the real keybinding.
      const at = JSON.parse(dropOutside);
      w.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      w.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 600));
      // Select-all + retype (cursor lands wherever the click put it, so
      // replacement — not appending — is the deterministic assertion).
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', code: 'KeyA', key: 'a', modifiers: ['control'] });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', code: 'KeyA', key: 'a', modifiers: ['control'] });
      await new Promise((r) => setTimeout(r, 300));
      for (const ch of 'outside-1-Xok') {
        w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 400));
      const diag = await w.webContents.executeJavaScript(`(() => ({
        focused: !!document.querySelector('.monaco-editor')?.contains(document.activeElement),
        dirty: !!document.querySelector('.dirty-dot'),
        ae: (document.activeElement?.tagName || '?') + '.' + (document.activeElement?.className || ''),
      }))()`);
      console.log('[smoke-ui] drop-outside diag: ' + JSON.stringify(diag));
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 's', code: 'KeyS', key: 's', modifiers: ['control'] });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 's', code: 'KeyS', key: 's', modifiers: ['control'] });
      await new Promise((r) => setTimeout(r, 1200));
      dropOutside = await w.webContents.executeJavaScript(`(async () => {
        const u = window.__barangTestUtils;
        if (typeof u.closeTab === 'function') await u.closeTab('${fwd}');
        await new Promise((r) => setTimeout(r, 400));
        return document.querySelector('.tab[data-path="${fwd}"]') ? 'tab-stuck' : 'ok';
      })()`);
    }
    if (dropOutside === 'ok') {
      const afterText = await fs.readFile(dropTmp, 'utf8');
      if (afterText !== 'outside-1-Xok') dropOutside = 'content-mismatch:' + afterText;
    }
    // Reveal in File Explorer on an outside-project file: real invoke (opens
    // the OS file manager selecting the temp file), then close only the
    // Explorer windows this invoke opened (HWND diff — never yours).
    const listExpHwnds = () => new Promise((resolve) => {
      let out = '';
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `$s=New-Object -ComObject Shell.Application;` +
        `@($s.Windows())|Where-Object{try{$_.FullName -match 'explorer\\.exe'}catch{$false}}|` +
        `ForEach-Object{$_.HWND}`], { windowsHide: true });
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('close', () => resolve(out));
      setTimeout(() => resolve(out), 15000);
    });
    if (dropOutside === 'ok') {
      const beforeHwnds = new Set((await listExpHwnds()).split(/[\s,]+/).filter(Boolean));
      const revealed = await w.webContents.executeJavaScript(
        `window.barang.app.revealPath('${fwd}').then(() => 'revealed', (e) => 'reveal-err:' + e.message)`,
      ).catch((e) => 'reveal-err:' + (e.message || e));
      if (revealed !== 'revealed') {
        dropOutside = revealed;
      } else {
        await new Promise((r) => setTimeout(r, 1500));
        const afterHwnds = (await listExpHwnds()).split(/[\s,]+/).filter(Boolean);
        const fresh = afterHwnds.filter((h) => !beforeHwnds.has(h));
        if (fresh.length) {
          await new Promise((resolve) => {
            const ps = spawn('powershell', ['-NoProfile', '-Command',
              `$n=@(${fresh.join(',')});$s=New-Object -ComObject Shell.Application;` +
              `@($s.Windows())|Where-Object{try{$_.FullName -match 'explorer\\.exe' -and $n -contains $_.HWND}catch{$false}}|` +
              `ForEach-Object{try{$_.Quit()}catch{}}`], { windowsHide: true });
            ps.on('close', () => resolve());
            setTimeout(resolve, 15000);
          });
          dropOutside = 'ok-revealed-cleaned';
        } else {
          dropOutside = 'reveal-no-window';
        }
      }
    }
  } catch (e) { dropOutside = 'error: ' + (e.message || e); }
  try { await fs.unlink(dropTmp); } catch {}
  console.log('[smoke-ui] drop-outside: ' + dropOutside);
  pass = pass && dropOutside === 'ok-revealed-cleaned';
  // Tab sessions (VSCode hot-exit): workspace + detached + untitled tabs
  // persist per project and reopen with unsaved content after close.
  let sessProbe = 'skip';
  const sessA = 'sess-restore-a.txt';
  const sessOutside = path.join(app.getPath('temp'), 'barang-sess-outside.txt');
  try {
    await fs.writeFile(sessOutside, 'outside-sess-1', 'utf8');
    const sessFwd = sessOutside.split(path.sep).join('/');
    sessProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      const need = ['openFile', 'closeAllTabs', 'flushTabSession', 'restoreTabSession', 'openUntitled', 'dropPaths'];
      for (const f of need) if (!u || typeof u[f] !== 'function') return 'no-fn:' + f;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      // Hermetic: earlier probes leave tabs behind — close them so the
      // snapshot/restore below deals only with this probe's tabs.
      await Promise.race([u.closeAllTabs(), new Promise((r) => setTimeout(r, 3000))]);
      if (document.querySelector('.tab')) {
        document.querySelector('.confirm-modal .btn-danger')?.click();
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (document.querySelector('.tab')) return 'slate-dirty';
      try { await window.barang.fs.write('${sessA}', 'aaa'); } catch (e) { return 'write-fail'; }
      await u.openFile('${sessA}', { group: 1 });
      await u.dropPaths(['${sessFwd}'], 1);
      u.openUntitled({ content: 'scratch-note', focus: false });
      await new Promise((r) => setTimeout(r, 1200));
      document.querySelector('.tab[data-path="${sessA}"]')?.click();
      await new Promise((r) => setTimeout(r, 600));
      if (document.querySelectorAll('.tab').length < 3) return 'tab-count:' + document.querySelectorAll('.tab').length;
      const ed = document.querySelector('.editor-host .monaco-editor');
      if (!ed) return 'no-monaco';
      const r = ed.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`);
    if (sessProbe.startsWith('{')) {
      const at = JSON.parse(sessProbe);
      const focusOk = async () => w.webContents.executeJavaScript(
        `!!document.querySelector('.monaco-editor')?.contains(document.activeElement)`,
      ).catch(() => false);
      const hasMarker = async () => w.webContents.executeJavaScript(
        `!!document.querySelector('.editor-host .monaco-editor .view-lines')?.textContent?.includes('-sessdirty')`,
      ).catch(() => false);
      const clickEd = async () => {
        w.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        w.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 600));
      };
      const typeMarker = async () => {
        for (const ch of '-sessdirty') {
          w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
          await new Promise((r) => setTimeout(r, 90));
        }
        await new Promise((r) => setTimeout(r, 500));
      };
      await clickEd();
      if (!(await focusOk())) await clickEd();
      if (!(await focusOk())) {
        // Last resort: direct textarea focus works even when the OS keeps
        // another window foregrounded (synthetic clicks need foreground).
        await w.webContents.executeJavaScript(
          `(() => { document.querySelector('.monaco-editor textarea.inputarea')?.focus(); return true; })()`,
        ).catch(() => false);
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!(await focusOk())) {
        sessProbe = 'focus-fail';
      } else {
        // A slipped focus can strand a partial marker (char 1 landed, rest
        // lost) — verify the full marker and retype (appends) until it
        // reads back, so the product asserts below judge the feature,
        // not the input rig.
        for (let t = 0; t < 3 && !(await hasMarker()); t++) {
          if (!(await focusOk())) await clickEd();
          await typeMarker();
        }
      }
    }
    if (sessProbe.startsWith('{')) {
      await new Promise((r) => setTimeout(r, 500));
      sessProbe = await w.webContents.executeJavaScript(`(async () => {
        const u = window.__barangTestUtils;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const st = await window.barang.app.state().catch(() => null);
        const key = 'barang.tabs.v1|' + ((st && st.root) || '').toLowerCase();
        u.flushTabSession();
        let snap = null;
        try { snap = JSON.parse(localStorage.getItem(key) || 'null'); } catch { return 'no-snap'; }
        if (!snap) return 'no-snap:' + key;
        const paths = (snap.tabs || []).map((t) => t.path);
        if (!paths.includes('${sessA}')) return 'snap-miss-a';
        if (!paths.includes('${sessFwd}')) return 'snap-miss-out';
        if (!String((snap.dirty || {})['${sessA}'] || '').includes('-sessdirty')) return 'snap-dirty';
        if (!(snap.untitled || []).some((x) => String(x.content || '').includes('scratch-note'))) return 'snap-untitled';
        const p = u.closeAllTabs();
        await sleep(800);
        const dlg = document.querySelector('.confirm-modal');
        if (!dlg) return 'no-dialog';
        dlg.querySelector('.btn-danger')?.click();
        if ((await p) !== true) return 'close-false';
        await sleep(400);
        if (document.querySelector('.tab')) return 'tabs-stuck';
        await u.restoreTabSession();
        await sleep(1800);
        const hasA = !!document.querySelector('.tab[data-path="${sessA}"]');
        const hasOut = !!document.querySelector('.tab[data-path="${sessFwd}"]');
        const hasUn = [...document.querySelectorAll('.tab-name')].some((n) => (n.textContent || '').startsWith('Untitled'));
        if (!hasA || !hasOut || !hasUn) return 'restore-miss:a=' + hasA + ' out=' + hasOut + ' un=' + hasUn;
        const dot = !!document.querySelector('.tab[data-path="${sessA}"] .dirty-dot');
        if (!dot) return 'restore-not-dirty';
        // Displayed-model text (not view-lines DOM: Monaco's painted rows
        // can lag a beat under automation while model + display are exact).
        const shown = u.debugDisplayedText ? u.debugDisplayedText(1) : null;
        if (typeof shown !== 'string' || !shown.includes('-sessdirty')) {
          return 'restore-content:active=' + activeTab + ' shownLen=' + (typeof shown === 'string' ? shown.length : shown);
        }
        const p2 = u.closeAllTabs();
        await sleep(800);
        document.querySelector('.confirm-modal .btn-danger')?.click();
        await p2;
        try { await window.barang.fs.remove('${sessA}'); } catch {}
        return 'ok';
      })()`);
    }
  } catch (e) { sessProbe = 'error: ' + (e.message || e); }
  try { await fs.unlink(sessOutside); } catch {}
  console.log('[smoke-ui] sess-restore: ' + sessProbe);
  pass = pass && sessProbe === 'ok';
  // Review flow: a seeded session edit reviews per-hunk against real disk
  // (reject hunk 0, then hunk 1, then Keep), plus Reject-all w/ confirm.
  // Per-run file/message ids: review state persists, so a re-seeded
  // identical review would (correctly) come back pre-reviewed.
  let reviewProbe = 'skip';
  const revFile = 'sess-review-' + Date.now().toString(36) + '.txt';
  const revMsg = 'm_rev_' + Date.now().toString(36);
  try {
    reviewProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.debugSetMessages !== 'function') return 'no-seed-fn';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const after = 'a\\nB\\nc\\nd\\ne\\nF\\ng\\nh';
      try { await window.barang.fs.write('${revFile}', after); } catch (e) { return 'write-fail'; }
      const st = await window.barang.app.state().catch(() => null);
      const root = ((st && st.root) || '').replace(/[/\\\\]+$/, '');
      const abs = root + '/' + '${revFile}';
      const patch = '@@ -1,3 +1,3 @@\\n a\\n-b\\n+B\\n c\\n@@ -5,4 +5,4 @@\\n e\\n-f\\n+F\\n g\\n h';
      u.debugSetMessages([{ info: { id: '${revMsg}', role: 'assistant' }, parts: [
        { type: 'tool', tool: 'edit', state: { metadata: { filediff: { file: abs, additions: 2, deletions: 2, patch } } } },
      ] }]);
      await sleep(900);
      const rowOf = () => [...document.querySelectorAll('.change-row')]
        .find((r) => (r.textContent || '').includes('${revFile}'));
      if (!rowOf()) return 'no-row';
      const chev = rowOf().querySelector('.change-chev');
      if (!chev) return 'no-chev';
      chev.click();
      await sleep(500);
      let hrs = [...document.querySelectorAll('.hunk-row')];
      if (hrs.length !== 2) return 'hunk-count:' + hrs.length;
      hrs[0].querySelector('button')?.click();
      await sleep(1300);
      let cur = '';
      try { cur = (await window.barang.fs.read('${revFile}')).content || ''; } catch (e) { return 'read-fail'; }
      if (cur !== 'a\\nb\\nc\\nd\\ne\\nF\\ng\\nh') return 'hunk0-content:' + JSON.stringify(cur);
      hrs = [...document.querySelectorAll('.hunk-row')];
      const open = hrs.filter((h) => h.querySelector('button'));
      if (open.length !== 1) return 'hunk-remain:' + open.length;
      open[0].querySelector('button')?.click();
      await sleep(1300);
      try { cur = (await window.barang.fs.read('${revFile}')).content || ''; } catch (e) { return 'read-fail2'; }
      if (cur !== 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh') return 'hunk1-content:' + JSON.stringify(cur);
      const keep = rowOf()?.querySelector('.change-keep');
      if (!keep) return 'no-keep';
      keep.click();
      await sleep(500);
      const wrap = rowOf()?.closest('.change-row-wrap');
      if (!wrap || !wrap.classList.contains('is-reviewed')) return 'not-dimmed';
      // Persistence: the reviewed fp must reach localStorage (reload must
      // not re-ask), and loadReviewedState must read it back.
      u.scheduleReviewedPersist();
      await sleep(1500);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('barang.review.v1') || 'null'); } catch {}
      const fp = u.changeFp({ kind: 'edit', additions: 2, deletions: 2, patch, status: 'modified', msg: '${revMsg}' });
      const hit = saved && Object.entries(saved.reviewed || {}).find(([k]) => k.endsWith('|${revFile}'));
      if (!hit || hit[1] !== fp) return 'persist-miss';
      const loaded = u.loadReviewedState();
      if (!loaded || loaded.reviewed < 1) return 'persist-load';
      return 'ok';
    })()`);
  } catch (e) { reviewProbe = 'error: ' + (e.message || e); }
  try {
    await w.webContents.executeJavaScript(`(async () => {
      try {
        const u = window.__barangTestUtils;
        if (u) u.debugSetMessages([]);
        try { await window.barang.fs.remove('${revFile}'); } catch {}
      } catch {}
      return 'cleaned';
    })()`);
  } catch {}
  console.log('[smoke-ui] review-hunks: ' + reviewProbe);
  pass = pass && reviewProbe === 'ok';
  // Image lightbox: a seeded chat image opens fullscreen (same src) and
  // closes on Escape — Cursor parity for attachment review.
  let lightboxProbe = 'skip';
  try {
    lightboxProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.openLightbox !== 'function' || typeof u.closeLightbox !== 'function') return 'no-lb-fns';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const png1px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      u.debugSetMessages([{ info: { id: 'm_lb', role: 'user' }, parts: [
        { type: 'text', text: 'see attachment' },
        { type: 'file', mime: 'image/png', filename: 'probe.png', url: png1px },
      ] }]);
      await sleep(700);
      const img = document.querySelector('.msg-img');
      if (!img) return 'no-img';
      img.click();
      await sleep(400);
      const ov = document.querySelector('.lightbox-overlay');
      if (!ov) return 'no-overlay';
      const big = ov.querySelector('.lightbox-img');
      if (!big || big.getAttribute('src') !== png1px) return 'src-mismatch';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(400);
      if (document.querySelector('.lightbox-overlay')) return 'stuck-open';
      u.debugSetMessages([]);
      return 'ok';
    })()`);
  } catch (e) { lightboxProbe = 'error: ' + (e.message || e); }
  try {
    await w.webContents.executeJavaScript(`(async () => {
      try { window.__barangTestUtils.debugSetMessages([]); } catch {}
      try { document.querySelector('.lightbox-overlay')?.remove(); } catch {}
      return 'cleaned';
    })()`);
  } catch {}
  console.log('[smoke-ui] lightbox: ' + lightboxProbe);
  pass = pass && lightboxProbe === 'ok';
  // Write-status truth: an untracked agent file shows "new", a tracked
  // overwrite shows real +/− counts (never a blanket "new").
  let writeStatProbe = 'skip';
  const wsNew = 'sess-status-new.txt';
  let wsOrig = '';
  try {
    wsOrig = await fs.readFile(path.join('C:\\Users\\Achi\\Desktop\\Barang', '.gitattributes'), 'utf8');
    writeStatProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.debugSetMessages !== 'function') return 'no-seed-fn';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try { await window.barang.fs.write('${wsNew}', 'hello\\n'); } catch (e) { return 'write-fail'; }
      try { await window.barang.fs.write('.gitattributes', ${JSON.stringify(wsOrig)} + '# probe\\n'); } catch (e) { return 'dirty-fail'; }
      const st = await window.barang.app.state().catch(() => null);
      const root = ((st && st.root) || '').replace(/[/\\\\]+$/, '');
      const mkWrite = (rel) => ({ type: 'tool', tool: 'write', state: { input: { filePath: root + '/' + rel } } });
      u.debugSetMessages([{ info: { id: 'm_ws', role: 'assistant' }, parts: [mkWrite('${wsNew}'), mkWrite('.gitattributes')] }]);
      await sleep(2500);
      const rowOf = (rel) => [...document.querySelectorAll('.change-row')]
        .find((r) => (r.querySelector('.change-path')?.textContent || '') === rel);
      const rowNew = rowOf('${wsNew}');
      const rowMod = rowOf('.gitattributes');
      if (!rowNew || !rowMod) return 'no-rows';
      const statNew = rowNew.querySelector('.change-stat')?.textContent || '';
      const statMod = rowMod.querySelector('.change-stat')?.textContent || '';
      if (!statNew.includes('new')) return 'new-badge:' + statNew;
      if (statNew.includes('+')) return 'new-counts:' + statNew;
      if (!statMod.includes('+1')) return 'mod-counts:' + statMod;
      return 'ok';
    })()`);
  } catch (e) { writeStatProbe = 'error: ' + (e.message || e); }
  try {
    await fs.writeFile(path.join('C:\\Users\\Achi\\Desktop\\Barang', '.gitattributes'), wsOrig);
  } catch {}
  try {
    await w.webContents.executeJavaScript(`(async () => {
      try {
        const u = window.__barangTestUtils;
        if (u) u.debugSetMessages([]);
        try { await window.barang.fs.remove('${wsNew}'); } catch {}
      } catch {}
      return 'cleaned';
    })()`);
  } catch {}
  console.log('[smoke-ui] write-status: ' + writeStatProbe);
  pass = pass && writeStatProbe === 'ok';
  // Git-less projects: existed-at-open decides new vs modified (switch to
  // a throwaway non-repo root and back — the hot-switch precedent).
  let nogitProbe = 'skip';
  const nogitDir = 'C:\\tmp\\nogit-proj';
  // Backslashes, template-escaped: resolveIn compares raw strings, so the
  // restored root must use native separators (forward slashes poison it).
  const backRoot = (process.env.BARANG_ROOT || 'C:\\Users\\Achi\\Desktop\\Barang').replace(/\\/g, '\\\\');
  try {
    await fs.rm(nogitDir, { recursive: true, force: true });
    await fs.mkdir(nogitDir, { recursive: true });
    await fs.writeFile(path.join(nogitDir, 'note.txt'), 'hi\\n');
    nogitProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.openPathFlow !== 'function' || typeof u.debugSetMessages !== 'function') return 'no-fns';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ND = 'C:\\\\tmp\\\\nogit-proj';
      await u.openPathFlow(ND);
      await sleep(5000);
      const st = await window.barang.app.state().catch(() => null);
      if (!st || st.root !== ND) return 'no-switch:' + (st && st.root);
      const mkWrite = (rel) => ({ type: 'tool', tool: 'write', state: { input: { filePath: ND + '/' + rel } } });
      // Phase 1: only the pre-existing file — snapshot lands without fresh2.
      u.debugSetMessages([{ info: { id: 'm_ng1', role: 'assistant' }, parts: [mkWrite('note.txt')] }]);
      await sleep(2500);
      // Phase 2: fresh2 created AFTER the snapshot — must read "new".
      try { await window.barang.fs.write('fresh2.txt', 'new here\\n'); } catch (e) { return 'write-fail'; }
      u.debugSetMessages([{ info: { id: 'm_ng2', role: 'assistant' }, parts: [mkWrite('note.txt'), mkWrite('fresh2.txt')] }]);
      await sleep(2500);
      const rowOf = (rel) => [...document.querySelectorAll('.change-row')]
        .find((r) => (r.querySelector('.change-path')?.textContent || '') === rel);
      const rowOld = rowOf('note.txt');
      const rowNew = rowOf('fresh2.txt');
      let out = 'pending-check';
      if (!rowOld || !rowNew) out = 'no-rows';
      else {
        const sOld = rowOld.querySelector('.change-stat')?.textContent || '';
        const sNew = rowNew.querySelector('.change-stat')?.textContent || '';
        if (sNew.includes('new') && !sNew.includes('+') && sOld.includes('modified')) out = 'ok';
        else out = 'badges:new=' + sNew + ' old=' + sOld;
      }
      await u.openPathFlow('${backRoot}');
      await sleep(5000);
      u.debugSetMessages([]);
      return out;
    })()`);
  } catch (e) { nogitProbe = 'error: ' + (e.message || e); }
  try { await fs.rm(nogitDir, { recursive: true, force: true }); } catch {}
  console.log('[smoke-ui] nogit-status: ' + nogitProbe);
  pass = pass && nogitProbe === 'ok';
  // Agentic Coding mode: centered chat posture (no IDE chrome), hero +
  // folder/branch meta, composer placeholder, and file-open exits to IDE.
  let agenticProbe = 'skip';
  try {
    agenticProbe = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      const need = ['enterAgenticFlow', 'exitAgentic', 'isAgentic'];
      for (const f of need) if (!u || typeof u[f] !== 'function') return 'no-fn:' + f;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Self-heal: a crashed earlier run may have left the flag/mode on.
      if (u.isAgentic()) {
        u.exitAgentic();
        await sleep(500);
      }
      // Hermetic transcript: the shared smoke session accumulates real
      // server-side messages across runs (which correctly hides the
      // empty-state hero) — so this probe works on a fresh empty session
      // and restores the original afterwards.
      if (typeof u.activeSessionId !== 'function' || typeof u.createSession !== 'function' ||
          typeof u.selectSession !== 'function') return 'no-session-fns';
      const origId = u.activeSessionId();
      let probeId = '';
      try {
        probeId = await u.createSession('agentic smoke');
      } catch (e) { return 'mk-session-fail'; }
      if (!probeId || typeof u.debugSetMessages !== 'function') return 'no-probe-session';
      const welcomeBtn = [...document.querySelectorAll('.welcome-actions button')]
        .find((b) => (b.textContent || '').includes('Vibe'));
      if (!welcomeBtn) return 'no-welcome-btn';
      await u.enterAgenticFlow();
      await sleep(1000);
      if (!u.isAgentic()) return 'not-entered';
      if (!document.body.classList.contains('agentic')) return 'no-body-class';
      const disp = (s) => {
        const n = document.querySelector(s);
        return n ? getComputedStyle(n).display : 'missing';
      };
      if (disp('.sidebar') !== 'none') return 'sidebar-visible';
      if (disp('.center') !== 'none') return 'center-visible';
      if (disp('.agent-wrap') === 'none') return 'panel-hidden';
      const input = document.querySelector('.composer-input');
      if (!input) return 'no-composer';
      if (!String(input.placeholder || '').includes('/ for commands')) return 'placeholder:' + input.placeholder;
      const hero = document.querySelector('.agentic-hero');
      if (!hero || hero.classList.contains('hidden')) {
        return 'no-hero:msgs=' + document.querySelectorAll('.msg').length;
      }
      const meta = document.querySelector('.agentic-meta');
      if (!meta || meta.classList.contains('hidden')) return 'no-meta';
      const branch = document.querySelector('.agentic-branch');
      if (!branch || branch.classList.contains('hidden') || !(branch.textContent || '').trim()) return 'no-branch';
      const ideBtn = [...document.querySelectorAll('.topbar .top-btn')]
        .find((b) => (b.title || '').includes('Back to editor'));
      if (!ideBtn || ideBtn.classList.contains('hidden')) return 'no-ide-btn';
      const vibeBtn = [...document.querySelectorAll('.topbar .top-btn')]
        .find((b) => (b.textContent || '').includes('Vibe'));
      // Vibe hides while agentic (welcome owns entry there); IDE shows.
      if (!vibeBtn || !vibeBtn.classList.contains('hidden')) return 'vibe-btn-visible';
      const folderBtn = document.querySelector('.agentic-folder');
      if (!folderBtn) return 'no-folder-btn';
      folderBtn.click();
      await sleep(500);
      const menu = document.querySelector('.ctx-menu');
      const menuText = menu ? (menu.textContent || '') : '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(300);
      if (!menu || !menuText.includes('Open folder')) return 'menu-bad:' + menuText.slice(0, 80);
      // Opening a file exits back to the IDE (palette quick-open path).
      await u.openFile('package.json', { group: 1 });
      await sleep(800);
      if (u.isAgentic()) return 'no-exit-on-open';
      if (document.body.classList.contains('agentic')) return 'body-stuck';
      if (disp('.sidebar') === 'none') return 'sidebar-stuck';
      const vibeBack = [...document.querySelectorAll('.topbar .top-btn')]
        .find((b) => (b.textContent || '').includes('Vibe'));
      if (!vibeBack || vibeBack.classList.contains('hidden')) return 'no-vibe-back-btn';
      try {
        const dd = await window.barang.app.defaultFolder();
        const rp = String((dd && dd.root) || '');
        const tail = (rp.split('/').pop() || '').split('\\\\').pop() || '';
        if (tail !== 'Default') return 'default-folder:' + rp.slice(-60);
      } catch (e) { return 'default-folder-err:' + (e.message || e); }
      if (typeof u.closeTab === 'function') await u.closeTab('package.json', 1);
      // Restore the original session and delete the probe one.
      try {
        if (probeId) await window.barang.oc('/session/' + probeId, { method: 'DELETE' });
      } catch {}
      try {
        if (origId) await u.selectSession(origId);
      } catch {}
      await sleep(600);
      return 'ok';
    })()`);
  } catch (e) { agenticProbe = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] agentic-mode: ' + agenticProbe);
  pass = pass && agenticProbe === 'ok';
  // Vibe polish: BARANG caps, seamless backdrop, compact send row, and a
  // single error voice (inline only — no echo toast, no second box).
  let vibePolish = 'skip';
  try {
    vibePolish = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.enterAgenticFlow !== 'function' || typeof u.debugSetError !== 'function') return 'no-fns';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (u.isAgentic()) u.exitAgentic();
      await u.enterAgenticFlow();
      await sleep(800);
      if (!u.isAgentic()) return 'not-entered';
      const wm = document.querySelector('.agentic-wordmark')?.textContent || '';
      if (wm !== 'BARANG') return 'wordmark:' + wm;
      const bg = getComputedStyle(document.querySelector('.agent-wrap')).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return 'backdrop:' + bg;
      const mw = getComputedStyle(document.querySelector('.composer .model-mini')).maxWidth;
      if (mw !== '210px') return 'model-width:' + mw;
      // One error voice: seed a message-level failure + store error.
      u.debugSetMessages([{ info: { id: 'm_verr', role: 'assistant', error: { name: 'X', data: { message: 'probe-boom-verify', statusCode: 500 } } }, parts: [{ type: 'text', text: 'working' }] }]);
      await sleep(300);
      u.debugSetError('probe-boom-verify');
      await sleep(1200);
      const runErr = [...document.querySelectorAll('.msg-runerr')].some((n) => (n.textContent || '').includes('probe-boom'));
      const errBox = document.querySelector('.chat-err');
      const boxHidden = !errBox || errBox.classList.contains('hidden');
      const echoToast = [...document.querySelectorAll('#toasts .toast')].some((n) => (n.textContent || '').includes('probe-boom'));
      u.debugSetMessages([]);
      u.debugSetError(null);
      u.exitAgentic();
      await sleep(400);
      if (!runErr) return 'no-inline-error';
      if (!boxHidden) return 'box-not-hidden';
      if (echoToast) return 'echo-toast';
      return 'ok';
    })()`);
  } catch (e) { vibePolish = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] vibe-polish: ' + vibePolish);
  pass = pass && vibePolish === 'ok';
  try {
    const anchor = await w.webContents.executeJavaScript(`(() => {
      const f = [...document.querySelectorAll('.tree-label')].find((b) => !(b.title || '').includes('/') && !b.querySelector('.tw'));
      if (f) f.click();
      return !!f;
    })()`);
    console.log('[smoke-ui] trusted focus-anchor: ' + anchor);
    // Dismiss the settings modal left open by earlier assertions — its
    // overlay would swallow the real clicks below.
    await w.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await new Promise((r) => setTimeout(r, 400));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const at = await w.webContents.executeJavaScript(`(() => {
      const side = document.querySelector('.sidebar');
      const head = document.querySelector('.side-header');
      const btn = document.querySelector('.side-header [title="New file"]');
      if (!btn) return { dbg: 'side=' + !!side + ' cls=' + (side?.className || '') + ' head=' + !!head + ' btns=' + document.querySelectorAll('.side-header button').length };
      const b = btn.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (at && at.dbg) {
      console.log('[smoke-ui] trusted sidebar dbg: ' + at.dbg);
    }
    let trusted = 'skip-no-button';
    if (at && !at.dbg) {
      w.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      w.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 700));
      const inp = await w.webContents.executeJavaScript(`(() => {
        const i = document.querySelector('.tree-prompt-input');
        if (!i) return null;
        i.value = '.barang-smoke-trusted/trusted-file.txt';
        const r = i.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, focused: document.activeElement === i };
      })()`);
      console.log('[smoke-ui] trusted prompt: ' + JSON.stringify(inp));
      if (inp) {
        w.webContents.sendInputEvent({ type: 'mouseDown', x: inp.x, y: inp.y, button: 'left', clickCount: 1 });
        w.webContents.sendInputEvent({ type: 'mouseUp', x: inp.x, y: inp.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 500));
        const pre = await w.webContents.executeJavaScript(`(() => {
          const i = document.querySelector('.tree-prompt-input');
          return i ? (document.activeElement === i) + '/' + i.value : 'gone';
        })()`);
        console.log('[smoke-ui] trusted pre-enter focus/value: ' + pre);
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', code: 'Enter', key: 'Enter' });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', code: 'Enter', key: 'Enter' });
        await new Promise((r) => setTimeout(r, 2500));
        trusted = await w.webContents.executeJavaScript(`(async () => {
          let exists = 'unknown';
          try { await window.barang.fs.read('.barang-smoke-trusted/trusted-file.txt'); exists = 'yes'; }
          catch (e) { exists = 'no:' + e.message; }
          try { await window.barang.fs.remove('.barang-smoke-trusted'); } catch {}
          return 'exists=' + exists + ' promptGone=' + (!document.querySelector('.tree-prompt-input')) +
            ' active=' + document.activeElement?.tagName + '.' + document.activeElement?.className;
        })()`);
      }
    }
    console.log('[smoke-ui] trusted-input: ' + trusted);
  } catch (e) {
    console.log('[smoke-ui] trusted-input error: ' + (e.message || e));
  }
  // Integrated terminal: statusbar toggle opens the panel, a real shell
  // spawns, echo roundtrips PTY -> xterm buffer, tab-x kills it.
  let termProbe = 'skip';
  try {
    termProbe = await w.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.status-term');
      if (!btn) return 'skip-no-status-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      const panel = document.getElementById('term-panel');
      if (!panel || panel.classList.contains('hidden')) return 'panel-did-not-open';
      let tab = document.querySelector('.term-tab');
      if (!tab) {
        const nb = document.querySelector('.term-action-new');
        if (!nb) return 'no-auto-tab-no-new-btn';
        nb.click();
        await new Promise((r) => setTimeout(r, 2500));
        tab = document.querySelector('.term-tab');
      }
      if (!tab) return 'no-tab-after-new';
      const id = tab.getAttribute('data-term-id');
      if (!id) return 'tab-without-id';
      await window.barang.term.write(id, 'echo barang-ui-term-4321\\r');
      let buf = '', tries = 0;
      while (!buf.includes('barang-ui-term-4321') && tries++ < 40) {
        await new Promise((r) => setTimeout(r, 250));
        try { buf = window.__barangTermBuffer(id) || ''; } catch { buf = ''; }
      }
      const echoed = buf.includes('barang-ui-term-4321');
      tab.querySelector('.term-tab-x')?.click();
      await new Promise((r) => setTimeout(r, 800));
      const gone = !document.querySelector('.term-tab[data-term-id="' + id + '"]');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return echoed && gone ? 'ok' : ('echoed=' + echoed + ' gone=' + gone);
    })()`);
  } catch (e) { termProbe = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] terminal: ' + termProbe);
  pass = pass && termProbe === 'ok';
  // Source control: seed a real worktree change, open SCM from the
  // statusbar, diff it, stage/unstage it through the row actions, badge on.
  // NOTE: the probe dir must NOT match .gitignore (`.barang-smoke*` is
  // ignored) or git status will never show it.
  let scmProbe = 'skip';
  try {
    scmProbe = await w.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.status-git');
      if (!btn || btn.classList.contains('hidden')) return 'skip-no-git-btn';
      // Self-heal: a previous interrupted run may have left a staged ghost.
      try { await window.barang.git('unstage', { paths: ['scm-probe-tmp/probe.txt'] }); } catch {}
      try { await window.barang.fs.remove('scm-probe-tmp'); } catch {}
      await window.barang.fs.write('scm-probe-tmp/probe.txt', 'v1');
      btn.click();
      await new Promise((r) => setTimeout(r, 3000));
      const scm = document.getElementById('view-scm');
      if (!scm || scm.classList.contains('hidden')) return 'scm-view-did-not-open';
      const branch = document.querySelector('.scm-branch span:not(.ic)')?.textContent?.trim() ?? '';
      const rows = document.querySelectorAll('.scm-row').length;
      const commit = !!document.querySelector('.scm-commit-btn');
      const badgeEl = document.querySelector('.side-view-btn .scm-badge');
      const badge = badgeEl && !badgeEl.classList.contains('hidden') ? 'ok' : 'missing';
      // The statusbar branch must pop the branch picker (select + create).
      const ctxText = document.querySelector('.ctx-menu')?.textContent ?? '';
      const menu = ctxText.includes('New Branch') && ctxText.includes(branch) ? 'ok' : 'missing:' + ctxText.slice(0, 60);
      const secCount = (title) => {
        const sec = [...document.querySelectorAll('.scm-sec')].find((s) => (s.querySelector('.scm-sec-title')?.textContent || '') === title);
        return parseInt(sec?.querySelector('.scm-count')?.textContent ?? 'x', 10);
      };
      const findRow = (secTitle) => {
        const sec = [...document.querySelectorAll('.scm-sec')].find((s) => (s.querySelector('.scm-sec-title')?.textContent || '') === secTitle);
        return [...(sec?.querySelectorAll('.scm-row') ?? [])].find((r) => (r.title || '').includes('scm-probe-tmp/probe.txt'));
      };
      let diff = 'no-rows';
      const row = findRow('Changes');
      if (row) {
        row.click();
        await new Promise((r) => setTimeout(r, 2500));
        const tab = document.querySelector('.tab.is-diff');
        diff = tab ? 'ok' : 'no-diff-tab';
        tab?.querySelector('.tab-x')?.click();
        await new Promise((r) => setTimeout(r, 600));
      }
      // Stage/unstage through the real row actions; assert BACKEND state
      // (git info is truth — DOM counts can lag paints under refresh races).
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const stagedHas = async () => {
        try {
          const st = await window.barang.git('info');
          return (st.staged || []).some((f) => f.path === 'scm-probe-tmp/probe.txt');
        } catch { return 'err'; }
      };
      let stage = 'skip', unstage = 'skip';
      for (let i = 0; i < 6 && stage !== 'ok'; i++) {
        const r = findRow('Changes');
        const b = r ? r.querySelectorAll('.scm-row-act')[1] : null;
        if (!b) break;
        b.click();
        await sleep(1500);
        if (await stagedHas() === true) stage = 'ok';
      }
      if (stage === 'ok') {
        // The backend flips before the repaint lands — wait for the staged
        // row to exist before clicking it (else we click stale DOM).
        let stRow = null;
        for (let i = 0; i < 12 && !stRow; i++) {
          stRow = findRow('Staged Changes');
          if (!stRow) await sleep(800);
        }
        if (!stRow) {
          unstage = 'no-row';
        } else {
          for (let i = 0; i < 6 && unstage !== 'ok'; i++) {
            const r = findRow('Staged Changes');
            const b = r ? r.querySelectorAll('.scm-row-act')[1] : null;
            if (!b) break;
            b.click();
            await sleep(1500);
            if (await stagedHas() === false) unstage = 'ok';
          }
          if (unstage === 'skip') unstage = 'no-change';
        }
      }
      try { await window.barang.git('unstage', { paths: ['scm-probe-tmp/probe.txt'] }); } catch {}
      try { await window.barang.fs.remove('scm-probe-tmp'); } catch {}
      // Dismiss the branch picker opened by the statusbar click, if any.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.side-view-btn')?.click();
      return 'branch=' + branch + ' rows=' + rows + ' commit=' + commit + ' diff=' + diff + ' stage=' + stage + ' unstage=' + unstage + ' badge=' + badge + ' menu=' + menu;
    })()`);
  } catch (e) { scmProbe = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] scm: ' + scmProbe);
  pass = pass && /^branch=\S+ rows=\d+ commit=true diff=ok stage=ok unstage=ok badge=ok menu=ok$/.test(scmProbe);
  // Notifications: bundled sounds decode, edge logic decides, IPC delivers.
  let notifSounds = 'skip';
  try {
    notifSounds = await w.webContents.executeJavaScript(`(async () => {
      const files = ['sounds/chime.wav','sounds/ding.wav','sounds/pop.wav','sounds/alert.wav','sounds/success.wav','sounds/complete.wav','sounds/approval.wav','sounds/error.wav','sounds/question.wav'];
      const out = [];
      for (const f of files) {
        try {
          const ok = await new Promise((res) => {
            const a = new Audio(f);
            const to = setTimeout(() => res('timeout'), 8000);
            a.addEventListener('loadedmetadata', () => { clearTimeout(to); res(a.duration > 0 ? 'ok' : 'zero'); });
            a.addEventListener('error', () => { clearTimeout(to); res('error'); });
          });
          out.push(f.split('/')[1] + '=' + ok);
        } catch (e) { out.push(f + '=throw'); }
      }
      return out.join(',');
    })()`);
  } catch (e) { notifSounds = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] notif-sounds: ' + notifSounds);
  pass = pass && /^([^,]+wav=ok,){8}[^,]+wav=ok$/.test(notifSounds);
  let notifDecide = 'skip';
  try {
    notifDecide = await w.webContents.executeJavaScript(`(() => {
      const d = window.__barangNotifDecide;
      if (typeof d !== 'function') return 'no-hook';
      const idle = { root: 'r', busy: false, error: null, perms: 0, questions: 0, activeId: 's' };
      const cases = [
        [{ ...idle, busy: true }, { ...idle }, 'done'],
        [{ ...idle }, { ...idle }, null],
        [{ ...idle, busy: true }, { ...idle, error: 'boom' }, 'error'],
        [{ ...idle }, { ...idle, perms: 2 }, 'approval'],
        [{ ...idle, busy: true, perms: 1 }, { ...idle, perms: 1 }, 'approval'],
        [{ ...idle, root: 'a', busy: true }, { ...idle, root: 'b' }, null],
        [{ ...idle, error: 'boom' }, { ...idle, error: 'boom' }, null],
        [{ ...idle, busy: true, activeId: 's1' }, { ...idle, activeId: 's2' }, null],
        [{ ...idle, busy: true, perms: 0 }, { ...idle, busy: true, perms: 1 }, 'approval'],
        [{ ...idle, busy: true, perms: 1 }, { ...idle, busy: true, perms: 1 }, null],
        [{ ...idle, busy: true, questions: 0 }, { ...idle, busy: true, questions: 1 }, 'question'],
        [{ ...idle, busy: true, questions: 1 }, { ...idle, questions: 0 }, 'done'],
        [{ ...idle }, { ...idle, questions: 1 }, 'question'],
        [{ ...idle, busy: true }, { ...idle, questions: 1 }, 'question'],
        [{ ...idle, busy: true }, { ...idle, perms: 1, questions: 1 }, 'question'],
      ];
      const bad = [];
      cases.forEach(([a, b, want], i) => {
        const got = d(a, b);
        if (got !== want) bad.push(i + ':' + got + '!==' + want);
      });
      return bad.length ? 'FAIL:' + bad.join(';') : 'ok-15';
    })()`);
  } catch (e) { notifDecide = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] notif-decide: ' + notifDecide);
  pass = pass && notifDecide === 'ok-15';
  let notifIpc = 'skip';
  try {
    notifIpc = await w.webContents.executeJavaScript(`(async () => {
      const r = await window.barang.app.notify({ title: 'Barang smoke', body: 'notify path check', kind: 'done', badge: false });
      return r && r.ok ? 'ok' : 'bad:' + JSON.stringify(r);
    })()`);
  } catch (e) { notifIpc = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] notif-ipc: ' + notifIpc);
  pass = pass && notifIpc === 'ok';
  // Per-kind sounds: resolver matrix, legacy migration, no-throw playback
  // for every kind (headless can't be heard — must resolve, never throw),
  // and remove-sound id validation.
  let notifKind = 'skip';
  try {
    notifKind = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.resolveKindSound !== 'function' || typeof u.normalizeNotifSoundSettings !== 'function') {
        return 'no-kind-fns';
      }
      const bad = [];
      const customs = [{ id: 'my1', name: 'My tone', fileUrl: 'file:///C:/tones/my1.wav' }];
      const picks = { done: 'ding', approval: 'custom:my1', error: 'custom:nope', question: 'question' };
      if (u.resolveKindSound('done', picks, customs) !== 'sounds/ding.wav') bad.push('kind-done');
      if (u.resolveKindSound('approval', picks, customs) !== 'file:///C:/tones/my1.wav') bad.push('kind-custom');
      if (u.resolveKindSound('error', picks, customs) !== 'sounds/error.wav') bad.push('kind-fallback');
      if (u.resolveKindSound('question', picks, customs) !== 'sounds/question.wav') bad.push('kind-question');
      if (u.resolveKindSound('done', { done: 'bogus', approval: '', error: '', question: '' }, []) !== 'sounds/complete.wav') bad.push('kind-unknown');
      // Legacy migration matrix.
      const m1 = u.normalizeNotifSoundSettings({ notifSoundName: 'ding' });
      if (m1.notifDoneSound !== 'ding' || m1.notifApprovalSound !== 'ding' || m1.notifErrorSound !== 'ding') bad.push('mig-single');
      if (m1.notifQuestionSound !== 'ding') bad.push('mig-single-q');
      if (m1.notifCustomSounds.length !== 0) bad.push('mig-single-custom');
      const m2 = u.normalizeNotifSoundSettings({ notifSoundName: 'custom', notifCustomName: 'My', notifCustomPath: 'file:///x' });
      if (m2.notifDoneSound !== 'custom:legacy' || m2.notifCustomSounds.length !== 1 || m2.notifCustomSounds[0].id !== 'legacy') bad.push('mig-legacy');
      const m3 = u.normalizeNotifSoundSettings({ notifDoneSound: 'pop', notifApprovalSound: 'custom:abc', notifCustomSounds: [{ id: 'abc', name: 'A', fileUrl: 'file:///a' }] });
      if (m3.notifDoneSound !== 'pop' || m3.notifApprovalSound !== 'custom:abc' || m3.notifErrorSound !== 'error') bad.push('mig-keep');
      const m4 = u.normalizeNotifSoundSettings({});
      if (m4.notifDoneSound !== 'complete' || m4.notifApprovalSound !== 'approval' || m4.notifErrorSound !== 'error' || m4.notifQuestionSound !== 'question') bad.push('mig-defaults');
      if (u.KIND_DEFAULT_SOUND.done !== 'complete' || u.KIND_DEFAULT_SOUND.approval !== 'approval' || u.KIND_DEFAULT_SOUND.error !== 'error' || u.KIND_DEFAULT_SOUND.question !== 'question') bad.push('kind-defaults');
      // Playback wiring: every kind resolves + play() never throws (false
      // when headless-blocked — only a throw fails). Single voice: the
      // second play takes over (no overlaps), verified via debug src.
      try {
        for (const k of ['done', 'approval', 'error', 'question']) {
          const url = u.resolveKindSound(k, picks, customs);
          const r = await u.playNotificationSound(url, 0.8);
          if (typeof r !== 'boolean') bad.push('play-type:' + k);
        }
        const rc = await u.playNotificationSound('file:///C:/tones/my1.wav', 0.8);
        if (typeof rc !== 'boolean') bad.push('play-custom-type');
        if (typeof u.debugAudioState !== 'function') bad.push('no-audio-state');
        else {
          const st1 = u.debugAudioState();
          await u.playNotificationSound('sounds/ding.wav', 0.8);
          await u.playNotificationSound('sounds/pop.wav', 0.8);
          const st2 = u.debugAudioState();
          if (typeof st1.src !== 'string' || typeof st2.src !== 'string') bad.push('audio-state-type');
          else if (!st2.src.endsWith('sounds/pop.wav')) bad.push('audio-switch:' + st2.src.slice(-40));
        }
      } catch (e) { bad.push('play-throw:' + (e.message || e)); }
      // Stop-edge silencer: one-shot, silent stops never celebrate.
      if (typeof u.quietNextStop !== 'function' || typeof u.consumeQuietStop !== 'function') {
        bad.push('no-quiet-fns');
      } else {
        if (u.consumeQuietStop() !== false) bad.push('quiet-fresh');
        u.quietNextStop();
        if (u.consumeQuietStop() !== true) bad.push('quiet-arm');
        if (u.consumeQuietStop() !== false) bad.push('quiet-once');
      }
      // remove-sound must reject traversal, accept missing-file delete.
      try {
        await window.barang.app.removeSound('../../evil');
        bad.push('rmsound-traversal');
      } catch (e) { /* expected */ }
      try {
        const r = await window.barang.app.removeSound('barang-smoke-no-such-file.wav');
        if (!r || r.ok !== true) bad.push('rmsound-missing');
      } catch (e) { bad.push('rmsound-missing-throw:' + (e.message || e)); }
      return bad.length ? 'FAIL:' + bad.join(';') : 'ok-kind';
    })()`);
  } catch (e) { notifKind = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] notif-kind: ' + notifKind);
  pass = pass && notifKind === 'ok-kind';
  // Perf caps: pure helpers + SCM 600-file render cap + auto-session decision.
  let perfCaps = 'skip';
  try {
    perfCaps = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u) return 'no-utils-hook';
      const bad = [];
      const arr = Array.from({ length: 500 }, (_, i) => i);
      const w1 = u.sliceWindow(arr, 150);
      if (w1.visible.length !== 150 || w1.hidden !== 350 || w1.visible[0] !== 350) bad.push('sliceWindow');
      const w2 = u.sliceWindow([1, 2], 150);
      if (w2.visible.length !== 2 || w2.hidden !== 0) bad.push('sliceWindow-small');
      const t1 = u.truncateText('abcdefghij', 4);
      if (t1.text !== 'abcd' || t1.truncated !== true) bad.push('truncateText');
      const t2 = u.truncateText('abc', 4);
      if (t2.text !== 'abc' || t2.truncated !== false) bad.push('truncateText-short');
      const auto = u.shouldAutoCreateSession;
      if (auto('proj', true, 0, false) !== true) bad.push('auto-yes');
      if (auto('', true, 0, false) !== false) bad.push('auto-noroot');
      if (auto('proj', false, 0, false) !== false) bad.push('auto-offline');
      if (auto('proj', true, 2, false) !== false) bad.push('auto-has');
      if (auto('proj', true, 0, true) !== false) bad.push('auto-busy');
      if (typeof u.highlightLine !== 'function') bad.push('no-hl-fn');
      else {
        const h1 = u.highlightLine('foo bar foo', [0, 3, 8, 3]);
        if ((h1.match(/<mark>/g) || []).length !== 2 || !h1.includes('bar')) bad.push('hl-count');
        const h2 = u.highlightLine('<b>x</b>', []);
        if (!h2.includes('&lt;b&gt;') || h2.includes('<mark>')) bad.push('hl-escape');
        const h3 = u.highlightLine('aaaa', [0, 2, 1, 2]);
        if ((h3.match(/<mark>/g) || []).length !== 1) bad.push('hl-overlap');
      }
      const pm = u.pickDefaultModel;
      const lbl = (m) => (m ? m.providerID + '/' + m.modelID : null);
      const pool = [
        { providerID: 'openrouter', modelID: 'poolside/laguna-s-2.1:free' },
        { providerID: 'openrouter', modelID: 'meta/muse-spark-1.3' },
        { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
        { providerID: 'openrouter', modelID: 'xiaomi/mimo-v2.6-flash' },
        { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' },
        { providerID: 'openai', modelID: 'gpt-5' },
      ];
      if (lbl(pm(pool)) !== 'opencode/muse-spark-1.3-contributor-free') bad.push('model-spark');
      if (lbl(pm(pool.filter((m) => !/muse-spark/i.test(m.modelID)))) !== 'opencode/mimo-v2.6-flash-free') bad.push('model-mimo');
      if (lbl(pm([{ providerID: 'openai', modelID: 'gpt-5' }])) !== null) bad.push('model-auto');
      if (lbl(pm([{ providerID: 'openrouter', modelID: 'xiaomi/mimo-v2.6-pro' }])) !== null) bad.push('model-paid-mimo');
      if (lbl(pm([
        { providerID: 'openrouter', modelID: 'xiaomi/mimo-v2.6-flash' },
        { providerID: 'openrouter', modelID: 'meta/muse-spark-1.3' },
      ])) !== 'openrouter/meta/muse-spark-1.3') bad.push('model-or-spark');
      // Send retry classification: fatal first (no duplicate re-POSTs).
      const t = u.isRetryableSendError;
      if (typeof t !== 'function') bad.push('no-retry-fn');
      else {
        if (t('Error from provider (Console): The request contains invalid parameters. Check the request body.') !== false) bad.push('retry-invalidparams');
        if (t('request failed with status 500: internal error') !== true) bad.push('retry-500');
        if (t('429 too many requests, rate limit exceeded') !== true) bad.push('retry-429');
        if (t('service unavailable, overloaded, try again later') !== true) bad.push('retry-overload');
        if (t('fetch failed: connection refused') !== true) bad.push('retry-conn');
        if (t('401 unauthorized: invalid api key') !== false) bad.push('retry-auth');
        if (t('unknown model opencode/muse-spark-1.2-old') !== false) bad.push('retry-model');
        if (t('') !== false) bad.push('retry-empty');
        let n = 0;
        const r = await u.withSendRetries(async () => { n++; if (n < 3) throw new Error('500 internal error'); return 'ok'; }, { sleep: () => Promise.resolve(), initialDelayMs: 1, maxDelayMs: 1 });
        if (r.value !== 'ok' || r.attempts !== 3) bad.push('retry-loop');
        let m = 0;
        try {
          await u.withSendRetries(async () => { m++; throw new Error('invalid parameters in request body'); }, { sleep: () => Promise.resolve() });
          bad.push('retry-fatal-throws');
        } catch (e) { if (m !== 1 || e.attempts !== 1) bad.push('retry-fatal-once'); }
      }
      // Attachment sanitizer: malformed parts must never reach the provider.
      const san = u.sanitizeOutgoingFiles;
      if (typeof san !== 'function') bad.push('no-san-fn');
      else {
        const good = { mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,iVBORw0KGgo=' };
        if (san([good]).length !== 1) bad.push('san-keep');
        if (san([{ mime: '', filename: 'a.png', url: 'data:;base64,xx' }]).length !== 0) bad.push('san-mime');
        if (san([{ mime: 'image/png', filename: '', url: good.url }]).length !== 0) bad.push('san-name');
        if (san([{ mime: 'image/png', filename: 'a.png', url: 'not-a-data-url' }]).length !== 0) bad.push('san-url');
      }
      // Stale model/agent overrides resolve before POST (no dead IDs sent).
      const rm = u.resolveSendModel;
      if (typeof rm !== 'function') bad.push('no-rm-fn');
      else {
        const cat = [{ providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' }];
        if ((rm({ providerID: 'opencode', modelID: 'muse-spark-1.3-old' }, cat, ['build'], 'build').model || {}).modelID !== 'mimo-v2.6-flash-free') bad.push('sendmodel-fallback');
        if (rm(null, cat, ['build'], 'build').agent !== 'build') bad.push('sendmodel-agent');
        if (rm(null, cat, ['build'], 'ghost').agent !== undefined) bad.push('sendmodel-ghost-agent');
        if (rm({ providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' }, [], [], 'build').agent !== 'build') bad.push('sendmodel-passthru');
      }
      // Opencode-style run state: server retry, stall, errors, permissions.
      const st = u.statusTextFor;
      if (typeof st !== 'function') bad.push('no-status-fn');
      else {
        if (st('retry', 2) !== 'Agent retrying… (attempt 2)') bad.push('status-retry');
        if (st('retry', 0) !== 'Agent retrying…') bad.push('status-retry0');
        if (st('busy', 0) !== 'Agent working… (busy)') bad.push('status-busy');
        if (!st('stalled', 0).startsWith('Agent stalled')) bad.push('status-stalled');
      }
      const me = u.messageErrorText;
      if (typeof me !== 'function') bad.push('no-msgerr-fn');
      else {
        if (me({ name: 'UnknownError', data: { message: 'boom happened' } }) !== 'boom happened') bad.push('msgerr-unknown');
        if (me({ name: 'APIError', data: { message: 'bad', statusCode: 400 } }) !== 'bad (HTTP 400)') bad.push('msgerr-api');
        if (me({ name: 'ProviderAuthError', data: { providerID: 'x', message: 'expired' } }) !== 'Provider sign-in error (x): expired') bad.push('msgerr-auth');
        if (me({ name: 'MessageAbortedError', data: { message: 'x' } }) !== null) bad.push('msgerr-abort');
        if (me(null) !== null || me('s') !== null) bad.push('msgerr-null');
      }
      const ds = u.decideStalled;
      if (typeof ds !== 'function') bad.push('no-stall-fn');
      else {
        if (ds(0, 121000, true, 'busy') !== true) bad.push('stall-yes');
        if (ds(0, 119000, true, 'busy') !== false) bad.push('stall-soon');
        if (ds(0, 999999, true, 'retry') !== false) bad.push('stall-retry');
        if (ds(0, 999999, false, 'busy') !== false) bad.push('stall-idle');
      }
      // Permission events: real 1.18 server shape (permission.asked) + newer.
      const pf = u.permissionFromEvent;
      if (typeof pf !== 'function') bad.push('no-perm-fn');
      else {
        const asked = { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['echo hi'], metadata: { command: 'echo hi' }, always: ['echo *'], tool: { messageID: 'msg_1', callID: 'call_1' } };
        const c1 = pf(asked);
        if (!c1 || c1.permissionID !== 'per_1' || c1.sessionID !== 'ses_1' || !c1.title.includes('bash') || !c1.title.includes('echo hi')) bad.push('perm-asked');
        if (!c1 || !(c1.detail || '').includes('echo *')) bad.push('perm-detail');
        const upd = { id: 'p2', type: 'edit', pattern: ['a.txt'], sessionID: 's2', messageID: 'm2', callID: 'c2', metadata: {} };
        const c2 = pf(upd);
        if (!c2 || c2.key !== 's2:p2' || !c2.title.includes('edit')) bad.push('perm-updated');
        if (pf(null) !== null || pf({}) !== null || pf({ id: 'x' }) !== null) bad.push('perm-garbage');
        // Multi-question requests keep every question (answerable 1-by-1).
        const qf = u.questionFromEvent;
        if (typeof qf !== 'function') bad.push('no-qevt-fn');
        else {
          const mq = qf({ id: 'qq', sessionID: 'ss', questions: [
            { header: 'H1', question: 'Q1?', options: [{ label: 'A' }, { label: 'B', description: 'second' }] },
            { header: 'H2', question: 'Q2?', options: [{ label: 'C' }] },
          ], tool: {} });
          if (!mq || mq.items.length !== 2 || mq.question !== 'Q1?' || mq.items[1].options.length !== 1) bad.push('perm-multi');
          if (qf(null) !== null || qf({}) !== null) bad.push('perm-multi-garbage');
        }
        // Ghost-busting: tombstoned dead waits never come back; repeats flag.
        if (typeof u.isRepeatAsk !== 'function' || typeof u.pruneQuestions !== 'function') bad.push('no-ghost-fns');
        else {
          const last = { sessionID: 's', text: 'Red or Blue?', at: 1000000 };
          if (u.isRepeatAsk(null, 's', 'Red or Blue?', 1000000) !== false) bad.push('rep-null');
          if (u.isRepeatAsk(last, 'other', 'Red or Blue?', 1000000) !== false) bad.push('rep-session');
          if (u.isRepeatAsk(last, 's', '  red   OR blue? ', 1000000) !== true) bad.push('rep-hit');
          if (u.isRepeatAsk(last, 's', 'Red or Blue?', 1000000 + 11 * 60 * 1000) !== false) bad.push('rep-stale');
          if (u.isRepeatAsk(last, 's', 'Different?', 1000000) !== false) bad.push('rep-text');
          const qa = { key: 's:q1', sessionID: 's', questionID: 'q1', header: '', question: 'Q?', options: [], items: [] };
          const qb = { key: 's:q2', sessionID: 's', questionID: 'q2', header: '', question: 'Q2?', options: [], items: [] };
          const pr = u.pruneQuestions([qa, qb], [qb], new Set(['s:q2']));
          if (pr.length !== 0) bad.push('prune-tomb');
          const pr2 = u.pruneQuestions([qa], [qa, qb], new Set());
          if (pr2.length !== 2 || pr2[1].key !== 's:q2') bad.push('prune-merge');
          const pr3 = u.pruneQuestions([qa, qb], [qa], new Set());
          if (pr3.length !== 1 || pr3[0].key !== 's:q1') bad.push('prune-gone');
        }
        const pa = u.parseAgentEvent;
        if (typeof pa !== 'function') bad.push('no-parse-fn');
        else {
          const ev = pa(JSON.stringify({ directory: '/x', payload: { type: 'permission.asked', properties: asked } }));
          if (!ev || ev.type !== 'permission.asked' || ev.directory !== '/x' || ev.props.id !== 'per_1') bad.push('parse-ev');
          if (pa('not json') !== null || pa('{"a":1}') !== null) bad.push('parse-garbage');
        }
        // Approval ghost-busting (multi-approval 404 fix): stale replies
        // drop the card, tombstones hold re-emits, clears are session-scoped.
        const se = u.isPermissionStaleError;
        if (typeof se !== 'function' || typeof u.upsertPermission !== 'function' ||
            typeof u.markPermissionAnswered !== 'function' || typeof u.clearSessionPermissions !== 'function' ||
            typeof u.pruneAnsweredKeys !== 'function' || typeof u.removePermission !== 'function') {
          bad.push('no-perm-ghost-fns');
        } else {
          if (se(new Error('HTTP 404')) !== true) bad.push('stale-404');
          if (se(new Error('404 Not Found: no such permission')) !== true) bad.push('stale-404b');
          if (se(new Error('HTTP 400')) !== false) bad.push('stale-400');
          if (se(new Error('boom')) !== false) bad.push('stale-other');
          const pa1 = { id: 'pp1', sessionID: 'ses_ta', permission: 'bash', patterns: ['x'], metadata: {}, tool: {} };
          const pa2 = { id: 'pp2', sessionID: 'ses_ta', permission: 'edit', patterns: ['y'], metadata: {}, tool: {} };
          const pb1 = { id: 'pp3', sessionID: 'ses_tb', permission: 'bash', patterns: ['z'], metadata: {}, tool: {} };
          const baseCards = [...document.querySelectorAll('.perm-card')].length;
          u.upsertPermission(pa1); u.upsertPermission(pa2); u.upsertPermission(pb1);
          await new Promise((r) => setTimeout(r, 400));
          if ([...document.querySelectorAll('.perm-card')].length !== baseCards + 3) bad.push('perm-cards');
          u.clearSessionPermissions('ses_ta');
          if (u.upsertPermission(pa1) !== null) bad.push('perm-tomb-readd');
          u.markPermissionAnswered(u.permissionFromEvent(pb1));
          await new Promise((r) => setTimeout(r, 400));
          if ([...document.querySelectorAll('.perm-card')].length !== baseCards) bad.push('perm-leftover');
          u.pruneAnsweredKeys('ses_ta'); u.pruneAnsweredKeys('ses_tb');
          // Real-server shape: a bogus permission id on a LIVE session must
          // come back 404-shaped, and the classifier must call it stale.
          try {
            const s = await window.barang.oc('/session', { method: 'POST', body: { title: 'barang perm probe' } });
            const sid = s && s.id;
            if (sid) {
              let shape = 'unexpected-ok';
              try {
                await window.barang.oc('/session/' + sid + '/permissions/per_bogus_1', { method: 'POST', body: { response: 'once' } });
              } catch (e) { shape = (e && e.message) || String(e); }
              try { await window.barang.oc('/session/' + sid, { method: 'DELETE' }); } catch {}
              if (/404|not found/i.test(shape)) {
                if (!se(new Error(shape))) bad.push('perm-srv-shape:' + shape.slice(0, 80));
              } else {
                bad.push('perm-srv-unexpected:' + String(shape).slice(0, 80));
              }
            } else {
              bad.push('perm-srv-no-session');
            }
          } catch (e) { bad.push('perm-srv-fail:' + ((e && e.message) || String(e)).slice(0, 60)); }
        }
        // Review engine: hunk-subset application (order-independent rejects).
        if (typeof u.parseUnifiedPatch !== 'function' || typeof u.applyHunkSubset !== 'function') {
          bad.push('no-hunk-fns');
        } else {
          const hp = '@@ -1,3 +1,3 @@\\n a\\n-b\\n+B\\n c\\n@@ -5,4 +5,4 @@\\n e\\n-f\\n+F\\n g\\n h';
          const before8 = 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh';
          const full8 = 'a\\nB\\nc\\nd\\ne\\nF\\ng\\nh';
          const hunks = u.parseUnifiedPatch(hp);
          if (!hunks || hunks.length !== 2) bad.push('hunk-parse');
          if (u.applyHunkSubset(before8, hp, new Set()) !== full8) bad.push('hunk-full');
          if (u.applyHunkSubset(before8, hp, new Set([0])) !== 'a\\nb\\nc\\nd\\ne\\nF\\ng\\nh') bad.push('hunk-skip0');
          if (u.applyHunkSubset(before8, hp, new Set([1])) !== 'a\\nB\\nc\\nd\\ne\\nf\\ng\\nh') bad.push('hunk-skip1');
          if (u.applyHunkSubset(before8, hp, new Set([0, 1])) !== before8) bad.push('hunk-skipall');
          if (u.applyHunkSubset(before8, 'garbage', new Set()) !== null) bad.push('hunk-garbage');
          if (u.applyHunkSubset('zzz\\n', hp, new Set()) !== null) bad.push('hunk-drift');
          if (u.parseUnifiedPatch('not a patch') !== null) bad.push('hunk-parse-garbage');
          // Re-edits re-pend review: same file, different messages → different fps.
          if (typeof u.deriveSessionChanges !== 'function' || typeof u.changeFp !== 'function') {
            bad.push('no-fp-fns');
          } else {
            const w1 = [{ info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'tool', tool: 'write', state: { input: { filePath: '/r/f.txt' } } }] }];
            const w2 = [{ info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'tool', tool: 'write', state: { input: { filePath: '/r/f.txt' } } }] }];
            const d1 = u.deriveSessionChanges(w1, '/r');
            const d2 = u.deriveSessionChanges(w2, '/r');
            if (d1.length !== 1 || d2.length !== 1) bad.push('fp-derive');
            else {
              if (u.changeFp(d1[0]) === u.changeFp(d2[0])) bad.push('fp-collide');
              if (!u.changeFp(d1[0]).endsWith('|m1') || !u.changeFp(d2[0]).endsWith('|m2')) bad.push('fp-msg');
              const d1b = u.deriveSessionChanges(w1, '/r');
              if (u.changeFp(d1[0]) !== u.changeFp(d1b[0])) bad.push('fp-unstable');
            }
          }
        }
        // Follow-up queue: cap, order, stubbed drain, requeue-on-refusal.
        if (typeof u.enqueueFollowUp !== 'function' || typeof u.queuedFollowUps !== 'function' ||
            typeof u.dequeueFollowUp !== 'function' || typeof u.removeQueuedFollowUp !== 'function' ||
            typeof u.clearQueuedFollowUps !== 'function' || typeof u.drainQueue !== 'function') {
          bad.push('no-queue-fns');
        } else {
          const qs = 'ses_q';
          u.clearQueuedFollowUps(qs);
          for (let i = 0; i < 7; i++) u.enqueueFollowUp(qs, 'm' + i);
          const snap = u.queuedFollowUps(qs);
          if (snap.length !== 5 || snap[0].text !== 'm2' || snap[4].text !== 'm6') bad.push('queue-cap');
          u.removeQueuedFollowUp(qs, 0);
          if (u.queuedFollowUps(qs)[0].text !== 'm3') bad.push('queue-remove');
          const got = [];
          const stub = async (t) => { got.push(t); return true; };
          if ((await u.drainQueue(qs, stub)) !== true) bad.push('queue-drain-false');
          if (got.length !== 1 || got[0] !== 'm3' || u.queuedFollowUps(qs).length !== 3) bad.push('queue-drain');
          const no = await u.drainQueue(qs, async () => false);
          if (no !== false || u.queuedFollowUps(qs).length !== 3 || u.queuedFollowUps(qs)[0].text !== 'm4') bad.push('queue-requeue');
          u.clearQueuedFollowUps(qs);
          if (u.queuedFollowUps(qs).length !== 0) bad.push('queue-clear');
          if ((await u.drainQueue(qs, stub)) !== false) bad.push('queue-drain-empty');
        }
      }
      const td = u.isTransportDown;
      if (typeof td !== 'function') bad.push('no-td-fn');
      else {
        if (td('opencode upstream failed: fetch failed') !== true) bad.push('td-fetch');
        if (td('HTTP 500') !== false) bad.push('td-http');
        if (td('invalid parameters') !== false) bad.push('td-fatal');
      }
      const fu = u.findUserMessage;
      if (typeof fu !== 'function') bad.push('no-fu-fn');
      else {
        const msgs = [
          { info: { id: 'msg_abc', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
          { info: { id: 'm2', role: 'assistant' }, parts: [] },
        ];
        if (fu(msgs, 'msg_abc', 'hi') !== true) bad.push('fu-id');
        if (fu(msgs, 'msg_nope', 'hi') !== false) bad.push('fu-miss');
      }
      // MCP config: parse/merge/validate/build + WordPress mapping.
      if (typeof u.parseMcpFile !== 'function' || typeof u.toServerList !== 'function' ||
        typeof u.buildFileText !== 'function' || typeof u.validateServer !== 'function' ||
        typeof u.parseKvLines !== 'function' || typeof u.toLiveConfig !== 'function' ||
        typeof u.wordpressQuickFill !== 'function' || typeof u.wordpressEndpoint !== 'function' ||
        typeof u.mergeStatuses !== 'function') bad.push('no-mcp-fns');
      else {
        const mp = u.parseMcpFile('{\\n// comment\\n"$schema": "x",\\n"mcp": { "wp": { "type": "remote", "url": "https://s/mcp", "oauth": false } },\\n}');
        if (!mp.mcp || !mp.mcp.wp) bad.push('mcp-parse');
        let threw = false;
        try { u.parseMcpFile('not json'); } catch { threw = true; }
        if (!threw) bad.push('mcp-parse-throws');
        if (u.parseMcpFile('').mcp === undefined || Object.keys(u.toServerList({})).length !== 0) bad.push('mcp-empty');
        const tl = u.toServerList({ wp: { type: 'remote', url: 'https://s/mcp' }, bad: 42, loc: { type: 'local', command: ['npx', 'x'] } });
        if (tl.length !== 2 || tl[0].name !== 'wp' || tl[1].command.join(' ') !== 'npx x') bad.push('mcp-list');
        const bf = u.buildFileText('{"model":"m","mcp":{"old":{"type":"remote","url":"https://o"}}}', { wp: { type: 'remote', url: 'https://n' } });
        const bj = JSON.parse(bf);
        if (bj.model !== 'm' || !bj.mcp || !bj.mcp.wp || bj.mcp.wp.url !== 'https://n' || bj.mcp.old) bad.push('mcp-build');
        let buildThrew = false;
        try { u.buildFileText('{{{nope', {}); } catch { buildThrew = true; }
        if (!buildThrew) bad.push('mcp-build-throws');
        if (u.validateServer({ name: 'bad name!', type: 'remote', url: 'x' }).length !== 2) bad.push('mcp-val-remote');
        if (u.validateServer({ name: 'ok', type: 'local', command: [] }).length !== 1) bad.push('mcp-val-local');
        if (u.validateServer({ name: 'ok', type: 'remote', url: 'https://s/mcp' }).length !== 0) bad.push('mcp-val-ok');
        const kv = u.parseKvLines('Authorization: Bearer abc\\n# comment\\n\\nX-Empty:\\nBadLine', ':');
        if (kv.Authorization !== 'Bearer abc' || kv['X-Empty'] !== '' || kv.BadLine !== undefined) bad.push('mcp-kv');
        const ke = u.parseKvLines('A=1\\nB = 2 ', '=');
        if (ke.A !== '1' || ke.B !== '2') bad.push('mcp-kv-env');
        const lc = u.toLiveConfig({ name: 'w', type: 'remote', url: 'https://s', headers: {}, oauth: false });
        if (lc.headers !== undefined || lc.oauth !== false) bad.push('mcp-live-drop');
        if (u.wordpressEndpoint('example.com ') !== 'https://example.com/wp-json/easy-mcp-ai/v1/mcp') bad.push('mcp-wp-url');
        if (u.wordpressEndpoint('https://s/wp-json/easy-mcp-ai/v1/mcp/') !== 'https://s/wp-json/easy-mcp-ai/v1/mcp') bad.push('mcp-wp-keep');
        const wq = u.wordpressQuickFill('example.com', 'wpmcp_123');
        if (wq.name !== 'wordpress' || wq.oauth !== false || wq.headers.Authorization !== 'Bearer wpmcp_123') bad.push('mcp-wp-fill');
        const wq2 = u.wordpressQuickFill('example.com', '');
        if (wq2.oauth !== true || wq2.headers.Authorization !== undefined) bad.push('mcp-wp-oauth');
        const mg = u.mergeStatuses(
          [{ name: 'a', type: 'remote', url: 'https://a' }, { name: 'b', type: 'remote', url: 'https://b', enabled: false }],
          { a: { status: 'connected' }, c: { status: 'connected' } },
        );
        if (mg.rows[0].effective !== 'connected') bad.push('mg-conn');
        if (mg.rows[1].effective !== 'disabled') bad.push('mg-dis');
        if (mg.foreign !== 1) bad.push('mg-foreign');
        const mg2 = u.mergeStatuses(
          [{ name: 'x', type: 'remote', url: 'https://x' }],
          { x: { status: 'failed', error: 'boom' } },
        );
        if (mg2.rows[0].effective !== 'failed' || !(mg2.rows[0].note || '').includes('boom')) bad.push('mg-fail');
        const mg3 = u.mergeStatuses([{ name: 'y', type: 'remote', url: 'https://y' }], {});
        if (mg3.rows[0].effective !== 'needs-restart') bad.push('mg-restart');
      }
      // Explorer copy paths: absolute vs root-relative, separator-aware.
      const po = u.pathOf;
      if (typeof po !== 'function') bad.push('no-pathof-fn');
      else {
        // NOTE: 4x backslashes in this file = 2x in the evaluated script =
        // a real single backslash at runtime (template-literal layering).
        if (po('C:\\\\proj', 'src/a.ts', true) !== 'C:\\\\proj\\\\src\\\\a.ts') bad.push('path-abs');
        if (po('C:\\\\proj', 'src/a.ts', false) !== 'src\\\\a.ts') bad.push('path-rel');
        if (po('/home/u/proj', 'src/a.ts', true) !== '/home/u/proj/src/a.ts') bad.push('path-posix');
        if (po('C:\\\\proj\\\\', 'src/a.ts', true) !== 'C:\\\\proj\\\\src\\\\a.ts') bad.push('path-clean');
        if (po('', 'src/a.ts', true) !== 'src/a.ts') bad.push('path-noroot');
      }
      // Pomodoro engine: phase table, clock, settings validation, dots.
      if (typeof u.pomoNext !== 'function' || typeof u.formatClock !== 'function' ||
        typeof u.normalizePomoSettings !== 'function' || typeof u.pomoDotsFilled !== 'function') bad.push('no-pomo-fns');
      else {
        const n1 = u.pomoNext('focus', 2, 4);
        if (n1.phase !== 'short' || n1.cycle !== 3) bad.push('pomo-short');
        const n2 = u.pomoNext('focus', 3, 4);
        if (n2.phase !== 'long' || n2.cycle !== 4) bad.push('pomo-long');
        const n3 = u.pomoNext('short', 3, 4);
        if (n3.phase !== 'focus' || n3.cycle !== 3) bad.push('pomo-back');
        if (u.formatClock(25 * 60000) !== '25:00') bad.push('pomo-clock');
        if (u.formatClock(59000) !== '0:59' || u.formatClock(0) !== '0:00' || u.formatClock(60001) !== '1:01') bad.push('pomo-clock-edge');
        const ns = u.normalizePomoSettings({ focusMin: 999, shortMin: 0, cycles: -3, autoFocus: 'yes' });
        if (ns.focusMin !== 180 || ns.shortMin !== 1 || ns.cycles !== 1 || ns.autoFocus !== false || ns.autoBreaks !== true) bad.push('pomo-clamp');
        if (u.normalizePomoSettings(null).focusMin !== 25) bad.push('pomo-defaults');
        if (u.pomoDotsFilled(0, 4) !== 0 || u.pomoDotsFilled(2, 4) !== 2 || u.pomoDotsFilled(4, 4) !== 4 || u.pomoDotsFilled(5, 4) !== 1) bad.push('pomo-dots');
      }
      // Chat file parts: images render inline, others chip, junk ignored.
      const fp = u.filePartView;
      if (typeof fp !== 'function') bad.push('no-filepart-fn');
      else {
        const img = fp({ type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,iVBORw0=' });
        if (!img || img.kind !== 'image' || !img.url.startsWith('data:image/')) bad.push('fp-image');
        const http = fp({ type: 'file', mime: 'image/jpeg', filename: 'b.jpg', url: 'https://x/y.jpg' });
        if (!http || http.kind !== 'image') bad.push('fp-http');
        const doc = fp({ type: 'file', mime: 'application/pdf', filename: 'd.pdf', url: 'data:application/pdf;base64,xx' });
        if (!doc || doc.kind !== 'file' || doc.name !== 'd.pdf') bad.push('fp-chip');
        if (fp({ type: 'file', mime: 'text/plain', filename: '', url: '' }) !== null) bad.push('fp-nameless');
        if (fp({ type: 'text', text: 'hi' }) !== null || fp(null) !== null) bad.push('fp-nofile');
        if (fp({ type: 'file', mime: 'image/png', filename: 'evil.png', url: 'file:///etc/passwd' }) !== null &&
          fp({ type: 'file', mime: 'image/png', filename: 'evil.png', url: 'file:///etc/passwd' }).kind === 'image') bad.push('fp-fileurl');
      }
      // Agent todos: header counts + checklist rendering data.
      const tp = u.todoProgress;
      if (typeof tp !== 'function') bad.push('no-todo-fn');
      else {
        const p1 = tp([
          { id: 'a', content: 'one', status: 'completed', priority: 'high' },
          { id: 'b', content: 'two', status: 'in_progress', priority: 'medium' },
          { id: 'c', content: 'three', status: 'pending', priority: 'low' },
        ]);
        if (p1.done !== 1 || p1.total !== 3 || p1.label !== '1 of 3 todos completed') bad.push('todo-count');
        const p2 = tp([]);
        if (p2.done !== 0 || p2.total !== 0 || p2.label !== 'No todos') bad.push('todo-empty');
        const p3 = tp([{ id: 'a', content: 'one', status: 'completed', priority: 'high' }]);
        if (p3.label !== '1 of 1 todo completed') bad.push('todo-single');
        const todosSec = document.querySelector('.todos-sec');
        if (!todosSec) bad.push('no-todos-sec');
        else {
          const title = todosSec.querySelector('.todos-title')?.textContent ?? '';
          if (!/todo/i.test(title)) bad.push('todos-title');
          if (!todosSec.classList.contains('hidden') && todosSec.querySelectorAll('.todo-row').length === 0) bad.push('todos-visible-no-rows');
        }
      }
      // Missing status entry = idle (server deletes entries on run end).
      const dst = u.decideStatus;
      if (typeof dst !== 'function') bad.push('no-dst-fn');
      else {
        const prev = { busy: true, status: 'busy', statusInfo: { type: 'busy' } };
        const idlePrev = { busy: false, status: 'idle', statusInfo: null };
        let r = dst(undefined, prev, 100000, 0);
        if (r.busy !== false || r.status !== 'idle') bad.push('dst-missing-idle');
        r = dst(undefined, prev, 3000, 0);
        if (r.busy !== true || r.status !== 'busy') bad.push('dst-grace-busy');
        r = dst({ type: 'retry', attempt: 2 }, prev, 100000, 0);
        if (r.busy !== true || r.status !== 'retry' || r.statusInfo.attempt !== 2) bad.push('dst-retry');
        r = dst({ type: 'idle' }, prev, 100000, 0);
        if (r.busy !== false) bad.push('dst-idle');
        r = dst(undefined, idlePrev, 100000, 0);
        if (r.busy !== false) bad.push('dst-idle-missing');
      }
      // Agent question waits: real 1.18 question.asked shape.
      const qf = u.questionFromEvent;
      if (typeof qf !== 'function') bad.push('no-q-fn');
      else {
        const q = qf({ id: 'que_1', sessionID: 'ses_1', questions: [{ header: 'Color', question: 'Red or Blue?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }], tool: { messageID: 'm1', callID: 'c1' } });
        if (!q || q.questionID !== 'que_1' || q.question !== 'Red or Blue?' || q.options.length !== 2 || q.options[0].label !== 'Red') bad.push('q-shape');
        if (qf(null) !== null || qf({}) !== null || qf({ id: 'x', sessionID: 's', questions: [] }) !== null) bad.push('q-garbage');
      }
      // Stall diagnosis copy.
      const da = u.describeActivity;
      if (typeof da !== 'function') bad.push('no-da-fn');
      else {
        if (!da([], [], [{ question: 'Red or Blue?' }]).includes('Red or Blue?')) bad.push('da-question');
        if (!da([], [{ title: 'bash: ls' }], []).includes('bash: ls')) bad.push('da-perm');
        const toolMsg = [{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', title: 'ls -la' } }] }];
        if (!da(toolMsg, [], []).includes('bash')) bad.push('da-tool');
        if (da([], [], []) !== 'no output yet') bad.push('da-empty');
      }
      if (st('stopping', 0) !== 'Agent stopping…') bad.push('status-stopping');
      // Editor TS setup: plain registered ids (worker reads JSX from the
      // file URI) + jsx flag on; every mapping must tokenize.
      if (typeof u.langOf !== 'function' || typeof u.getTsDiagOptions !== 'function' || typeof u.registeredLanguageIds !== 'function') bad.push('no-ts-fns');
      else {
        if (u.langOf('src/main.tsx') !== 'typescript') bad.push('lang-tsx');
        if (u.langOf('src/a.jsx') !== 'javascript') bad.push('lang-jsx');
        if (u.langOf('src/a.ts') !== 'typescript') bad.push('lang-ts');
        if (u.langOf('src/a.js') !== 'javascript') bad.push('lang-js');
        if (u.langOf('x.mts') !== 'typescript') bad.push('lang-mts');
        const reg = u.registeredLanguageIds();
        if (!Array.isArray(reg) || !reg.includes('typescript') || !reg.includes('javascript')) bad.push('no-reg-list');
        else {
          for (const f of ['a.tsx', 'a.ts', 'a.jsx', 'a.js', 'a.mts', 'a.json', 'a.css', 'a.md', 'a.py', 'a.rs', 'x.unknown']) {
            if (!reg.includes(u.langOf(f))) bad.push('unregistered:' + f);
          }
          if (reg.includes('typescriptreact') && u.langOf('a.tsx') === 'typescriptreact') bad.push('react-id-unneeded');
        }
        const to = u.getTsDiagOptions();
        if (!to) bad.push('no-ts-opts');
        else {
          if (to.jsx === 0 || to.jsx === undefined) bad.push('tsx-no-jsx-flag');
          if (to.moduleResolution === undefined) bad.push('tsx-no-modres');
        }
        // Import map: tsconfig paths + dep-aware 2307 triage.
        if (typeof u.parseTsconfigPaths !== 'function' || typeof u.matchAlias !== 'function' ||
          typeof u.packageNameOf !== 'function' || typeof u.candidateImportPaths !== 'function') bad.push('no-importmap-fns');
        else {
          const viteCfg = '{\\n// comment\\n"compilerOptions": {\\n"baseUrl": ".",\\n"paths": { "@/*": ["./src/*"], "@utils": ["./src/utils"] },\\n},\\n}';
          const tp = u.parseTsconfigPaths(viteCfg);
          if (tp.baseUrl !== '.' || tp.entries.length !== 2) bad.push('tsconfig-parse');
          if (u.parseTsconfigPaths('not json').entries.length !== 0) bad.push('tsconfig-garbage');
          const m1 = u.matchAlias('@/components/X', tp.entries);
          if (!m1 || m1.targets[0] !== './src/*' || m1.rest !== 'components/X') bad.push('alias-star');
          const m2 = u.matchAlias('@utils', tp.entries);
          if (!m2 || m2.rest !== '') bad.push('alias-exact');
          if (u.matchAlias('./rel', tp.entries) !== null || u.matchAlias('@/other', [{ pattern: '@x/*', targets: [] }]) !== null) bad.push('alias-miss');
          if (u.packageNameOf('@/components/X') !== null) bad.push('pkg-relative-leak');
          if (u.packageNameOf('react-router-dom/Bogus') !== 'react-router-dom') bad.push('pkg-subpath');
          if (u.packageNameOf('@scope/pkg/sub') !== '@scope/pkg') bad.push('pkg-scope');
          if (u.packageNameOf('./rel') !== null) bad.push('pkg-rel');
          const map = { baseDir: '', aliases: tp.entries, deps: new Set() };
          const cands = u.candidateImportPaths('src/pages', '@/components/layout/Footer', map);
          if (!cands.includes('src/components/layout/Footer.tsx')) bad.push('cand-alias:' + cands.slice(0, 3).join(','));
          const rel = u.candidateImportPaths('src/pages', '../lib/x', map);
          if (!rel.includes('src/lib/x.ts')) bad.push('cand-rel');
          if (u.candidateImportPaths('src', 'react', map).length !== 0) bad.push('cand-bare');
          const sr = u.specResolves;
          if (typeof sr !== 'function') bad.push('no-resolve-fn');
          else {
            const files = new Set(['src/components/layout/Footer.tsx', 'src/lib/x.ts', 'src/pages/AboutPage.tsx']);
            const exists = async (rel) => files.has(rel);
            const mmap = { baseDir: '', aliases: tp.entries, deps: new Set(['react', 'react-router-dom']) };
            if (await sr('@/components/layout/Footer', 'src', mmap, exists) !== true) bad.push('res-alias-hit');
            if (await sr('@/components/Nope', 'src', mmap, exists) !== false) bad.push('res-alias-miss');
            if (await sr('../lib/x', 'src/pages', mmap, exists) !== true) bad.push('res-rel-hit');
            if (await sr('../lib/ghost', 'src/pages', mmap, exists) !== false) bad.push('res-rel-miss');
            if (await sr('react-router-dom', 'src', mmap, exists) !== true) bad.push('res-dep-hit');
            if (await sr('left-pad-xyz', 'src', mmap, exists) !== false) bad.push('res-dep-miss');
            if (await sr('', 'src', mmap, exists) !== false) bad.push('res-empty');
          }
        }
      }
      // Permission cards: structured kind/target + middle-ellipsis titles.
      const sm = u.shortenMiddle;
      if (typeof sm !== 'function') bad.push('no-shorten-fn');
      else {
        if (sm('abcdefghij', 4) !== 'abcdefghij') bad.push('shorten-short');
        const s40 = sm('C:\\\\Users\\\\Achi\\\\Desktop\\\\LogoMaker\\\\lokalistik\\\\renders-v10\\\\*', 40);
        if (s40.length !== 40 || !s40.includes('…') || !s40.endsWith('*')) bad.push('shorten-mid');
        if (sm('', 40) !== '') bad.push('shorten-empty');
      }
      const ca = u.classifyAttachFile;
      if (typeof ca !== 'function') bad.push('no-classify-fn');
      else {
        if (ca('shot.png', 100) !== 'image') bad.push('class-image');
        if (ca('photo.JPG', 100) !== 'image') bad.push('class-image-case');
        if (ca('notes.txt', 100) !== 'mention') bad.push('class-mention');
        if (ca('big.png', 9 * 1024 * 1024) !== 'too-large') bad.push('class-large');
        if (ca('', 100) !== 'skip') bad.push('class-skip');
      }
      const pf2 = u.permissionFromEvent;
      if (typeof pf2 === 'function') {
        const c = pf2({ id: 'p1', sessionID: 's1', permission: 'external_directory', patterns: ['C:\\proj\\renders-v10\\*'], metadata: {}, always: ['C:\\proj\\renders-v10\\*'] });
        if (!c || c.kind !== 'external_directory' || c.target !== 'C:\\proj\\renders-v10\\*') bad.push('perm-structured');
        if (!c || !c.title.startsWith('external_directory:')) bad.push('perm-title');
      }
      if (bad.length) return 'unit-FAIL:' + bad.join(';');
      // Self-heal leftovers from an interrupted run (a stale 2000-file dir
      // would blow the cap budget and hide this probe's own files).
      try { await window.barang.fs.remove('perf-cap-scm'); } catch {}
      try { await window.barang.fs.remove('perf-cap-tree'); } catch {}
      for (let i = 0; i < 600; i++) {
        await window.barang.fs.write('perf-cap-scm/f' + i + '.txt', 'x' + i);
      }
      document.querySelector('.status-git')?.click();
      await new Promise((r) => setTimeout(r, 4000));
      const chSec = [...document.querySelectorAll('.scm-sec')].find((s) => (s.querySelector('.scm-sec-title')?.textContent || '') === 'Changes');
      const count = parseInt(chSec?.querySelector('.scm-count')?.textContent ?? 'x', 10);
      const rows = chSec ? chSec.querySelectorAll('.scm-row').length : -1;
      const more = [...(chSec?.querySelectorAll('.scm-none') ?? [])].some((d) => (d.textContent || '').includes('more'));
      try { await window.barang.fs.remove('perf-cap-scm'); } catch {}
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      document.querySelector('.side-view-btn')?.click();
      if (!(count >= 600)) return 'scm-count:' + count;
      if (!(rows > 0 && rows <= 210)) return 'scm-rows:' + rows;
      if (!more) return 'scm-no-more-row';
      return 'ok';
    })()`);
  } catch (e) { perfCaps = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] perf-caps: ' + perfCaps);
  pass = pass && perfCaps === 'ok';
  // Explorer cap: 2100 files in one dir render <=2000 rows + more-row.
  let treeCap = 'skip';
  try {
    treeCap = await w.webContents.executeJavaScript(`(async () => {
      try { await window.barang.fs.remove('perf-cap-tree'); } catch {}
      try { await window.barang.fs.remove('perf-cap-scm'); } catch {}
      for (let i = 0; i < 2100; i++) {
        await window.barang.fs.write('perf-cap-tree/g' + i + '.txt', 'y');
      }
      document.querySelector('.side-header [title="Refresh"]')?.click();
      await new Promise((r) => setTimeout(r, 2500));
      const lbl = [...document.querySelectorAll('.tree-label')].find((b) => (b.title || '') === 'perf-cap-tree');
      if (!lbl) return 'no-dir-row';
      lbl.click();
      await new Promise((r) => setTimeout(r, 4000));
      const live = document.querySelector('#view-explorer');
      const lbl2 = [...live.querySelectorAll('.tree-label')].find((b) => (b.title || '') === 'perf-cap-tree');
      const sub = lbl2?.closest('.tree-row')?.nextElementSibling;
      const isSub = sub && sub.classList.contains('tree-sub');
      const rows = isSub ? sub.querySelectorAll('.tree-row').length : -1;
      const more = isSub ? !!sub.querySelector('.tree-more') : false;
      lbl2?.click();
      try { await window.barang.fs.remove('perf-cap-tree'); } catch {}
      if (!isSub) return 'not-expanded';
      if (!(rows > 0 && rows <= 2000)) return 'tree-rows:' + rows;
      if (!more) return 'tree-no-more-row';
      return 'ok';
    })()`);
  } catch (e) { treeCap = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] tree-cap: ' + treeCap);
  pass = pass && treeCap === 'ok';
  // Offline-banner retry channel: restarts the bundled server, returns root.
  let retryOc = 'skip';
  try {
    retryOc = await w.webContents.executeJavaScript(`(async () => {
      const r = await window.barang.app.retryOpencode();
      return r && typeof r.root === 'string' ? 'ok' : 'bad:' + JSON.stringify(r);
    })()`);
  } catch (e) { retryOc = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] retry-opencode: ' + retryOc);
  pass = pass && retryOc === 'ok';
  // Settings UI: nav rail lists all sections, rows are toggle switches that
  // flip state, nav click scrolls to the section.
  let settingsUi = 'skip';
  try {
    settingsUi = await w.webContents.executeJavaScript(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      document.querySelector('.topbar .settings-btn')?.click();
      await new Promise((r) => setTimeout(r, 600));
      const switches = document.querySelectorAll('.settings-overlay .switch-input').length;
      const navItems = [...document.querySelectorAll('.settings-overlay .settings-nav-item')].map((b) => b.textContent);
      let navOk = 'no-nav';
      const notifBtn = [...document.querySelectorAll('.settings-overlay .settings-nav-item')].find((b) => b.textContent === 'Notifications');
      if (notifBtn) {
        notifBtn.click();
        await new Promise((r) => setTimeout(r, 600));
        const sec = document.querySelector('.settings-overlay #sec-notifications');
        const body = document.querySelector('.settings-overlay .settings-body');
        navOk = (sec && body && Math.abs(sec.getBoundingClientRect().top - body.getBoundingClientRect().top) < 120) ? 'ok' : 'no-scroll';
      }
      let tog = 'skip';
      const free = document.querySelector('.settings-overlay .switch-input');
      if (free) {
        const before = free.checked;
        free.click();
        await new Promise((r) => setTimeout(r, 300));
        const mid = free.checked;
        free.click();
        await new Promise((r) => setTimeout(r, 300));
        tog = (mid !== before && free.checked === before) ? 'ok' : 'stuck';
      }
      const overlayText = document.querySelector('.settings-overlay .settings-body')?.textContent || '';
      const snd = ['Run finished sound', 'Approval sound', 'Question sound', 'Error sound', 'Add custom sound'].every((t) => overlayText.includes(t))
        && [...document.querySelectorAll('.settings-overlay button')].some((b) => b.textContent === 'Approval')
        && [...document.querySelectorAll('.settings-overlay button')].some((b) => b.textContent === 'Question')
        ? 'ok' : 'missing';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return 'switches=' + switches + ' nav=' + navItems.length + ' navOk=' + navOk + ' tog=' + tog + ' snd=' + snd;
    })()`);
  } catch (e) { settingsUi = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] settings-ui: ' + settingsUi);
  pass = pass && /nav=11 navOk=ok tog=ok/.test(settingsUi) && /snd=ok/.test(settingsUi) && parseInt(settingsUi.split('switches=')[1]) >= 15;
  // Bolt E2E (local stub server above — no internet): pure helpers, then a
  // real UI flow — new request, POST JSON + header, send, save, project
  // mirror, history. Hermetic: localStorage + mirror file snapshotted first.
  let boltE2e = 'skip';
  try {
    boltE2e = await w.webContents.executeJavaScript(`(async (port) => {
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const u = window.__barangTestUtils;
      if (!u || !u.substituteVars) return 'no-bolt-utils';
      const bad = [];
      if (u.substituteVars('{{a}}/x/{{ b }}', { a: '1', b: '2' }) !== '1/x/2') bad.push('subst');
      if (u.substituteVars('{{zzz}}', {}) !== '{{zzz}}') bad.push('subst-unknown');
      if (u.buildUrl('http://h/p', [{ key: 'a', value: '1', enabled: true }]) !== 'http://h/p?a=1') bad.push('buildUrl');
      const b2 = u.buildUrl('http://h/p?x=0', [{ key: 'a', value: '1', enabled: true }, { key: 'off', value: '9', enabled: false }]);
      if (!(b2.includes('x=0') && b2.includes('a=1') && !b2.includes('off'))) bad.push('buildUrl-merge');
      const pp = u.parseUrlParams('http://h/p?a=1&b=2');
      if (pp.length !== 2 || pp[0].key !== 'a' || pp[1].value !== '2') bad.push('parse');
      const pr = u.prettyBody('{"a":1}');
      if (!pr.isJson || !pr.pretty.includes('\\n')) bad.push('pretty');
      if (u.prettyBody('plain').isJson) bad.push('pretty-raw');
      if (!u.highlightJson('{"k":1}').includes('jk')) bad.push('highlight');
      if (!u.headerValueSuggestions('Accept').includes('application/json')) bad.push('hdr-accept');
      if (!u.headerValueSuggestions('CONTENT-TYPE').includes('application/json')) bad.push('hdr-case');
      if (u.headerValueSuggestions('X-Custom-Thing').length !== 0) bad.push('hdr-unknown');
      if (!(Array.isArray(u.COMMON_HEADER_NAMES) && u.COMMON_HEADER_NAMES.length >= 10 && u.COMMON_HEADER_NAMES.includes('Authorization'))) bad.push('hdr-names');
      if (bad.length) return 'unit-FAIL:' + bad.join(';');
      const lsBolt = localStorage.getItem('barang:bolt-v1');
      const lsHist = localStorage.getItem('barang:bolt-hist-v1');
      let mirrorHad = false, mirrorBefore = null;
      try { const f = await window.barang.fs.read('.barang/bolt/my-collection.json'); mirrorHad = true; mirrorBefore = f.content; } catch (e) {}
      let e2e = 'not-run';
      try {
        const viewBtn = document.querySelector('[title="Bolt — API client"]');
        if (!viewBtn) e2e = 'no-view-btn';
        else {
          viewBtn.click();
          await sleep(600);
          if (document.getElementById('view-api')?.classList.contains('hidden')) e2e = 'view-did-not-open';
          else {
            const newBtn = document.querySelector('#view-api [title="New request"]');
            if (!newBtn) e2e = 'no-new-btn';
            else {
              newBtn.click();
              await sleep(1000);
              const ms = document.querySelector('.bolt-method-sel');
              if (!ms) e2e = 'no-builder';
              else {
                ms.value = 'POST'; ms.dispatchEvent(new Event('change', { bubbles: true }));
                const url = document.querySelector('.bolt-url');
                url.value = 'http://127.0.0.1:' + port + '/echo?probe=1';
                url.dispatchEvent(new Event('change', { bubbles: true }));
                const bs = document.querySelector('.bolt-body-sel');
                bs.value = 'json'; bs.dispatchEvent(new Event('change', { bubbles: true }));
                await sleep(400);
                const ta = document.querySelector('.bolt-body-text');
                ta.value = JSON.stringify({ ping: 'bolt-e2e-marker' });
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                const hb = [...document.querySelectorAll('.bolt-subtab')].find((b) => b.textContent === 'Headers');
                if (hb) hb.click();
                await sleep(300);
                const subDbg = 'subtabs=[' + [...document.querySelectorAll('.bolt-subtab')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')).join('|') + ']';
                const paneDbg = 'panes=[' + [...document.querySelectorAll('.bolt-pane')].map((p) => (p.classList.contains('hidden') ? 'H' : 'V')).join(',') + ']';
                const adds = [...document.querySelectorAll('.bolt-pane:not(.hidden) .bolt-kv-add')];
                const commonBtn = adds.find((b) => (b.textContent || '').includes('Common'));
                if (commonBtn) commonBtn.click();
                await sleep(400);
                const presetItem = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => (b.textContent || '').includes('Accept'));
                if (presetItem) presetItem.click();
                await sleep(400);
                const rowAdds = [...document.querySelectorAll('.bolt-pane:not(.hidden) .bolt-kv-add')].filter((b) => !(b.textContent || '').includes('Common'));
                if (rowAdds[0]) rowAdds[0].click();
                await sleep(300);
                const keys = [...document.querySelectorAll('.bolt-pane:not(.hidden) .bolt-kv-key')];
                const vals = [...document.querySelectorAll('.bolt-pane:not(.hidden) .bolt-kv-val')];
                const k = keys[keys.length - 1], v = vals[vals.length - 1];
                if (k && v) {
                  k.value = 'x-mirror'; k.dispatchEvent(new Event('input', { bubbles: true }));
                  v.value = 'hdr-marker'; v.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const dlOk = document.querySelectorAll('.bolt-req datalist option').length >= 10;
                if (!dlOk) e2e = 'no-datalists';
                const send = dlOk ? document.querySelector('.bolt-send') : null;
                if (!send && dlOk) e2e = 'no-send';
                if (send) {
                  send.click();
                  let status = '', tries = 0;
                  while (tries++ < 40) {
                    await sleep(250);
                    status = document.querySelector('.bolt-status')?.textContent ?? '';
                    const errBox = document.querySelector('.bolt-res-error')?.textContent ?? '';
                    if (/^200/.test(status)) break;
                    if (errBox) { status = 'ERRBOX:' + errBox.slice(0, 120); break; }
                  }
                  if (!/^200/.test(status)) e2e = 'send-failed:' + status;
                  else {
                    const pre = document.querySelector('.bolt-pre')?.textContent ?? '';
                    const hasHl = !!document.querySelector('.bolt-pre .jk');
                    const hasMarker = pre.includes('bolt-e2e-marker');
                    const hasProbe = pre.includes('probe');
                    const hasHdr = pre.includes('hdr-marker');
                    if (!(hasMarker && hasProbe && hasHdr && hasHl)) e2e = 'echo-mismatch:m=' + hasMarker + ' p=' + hasProbe + ' h=' + hasHdr + ' hl=' + hasHl + ' ' + subDbg + ' ' + paneDbg + ' kv=[' + [...document.querySelectorAll('.bolt-pane:not(.hidden) .bolt-kv')].map((r) => (r.querySelector('.bolt-kv-key')?.value || '') + '=' + (r.querySelector('.bolt-kv-val')?.value || '')).join(';') + '] pre=[' + pre.slice(0, 200) + ']';
                    else {
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
                      await sleep(1200);
                      const allRows = [...document.querySelectorAll('#view-api .bolt-req-row')];
                      const row = allRows.find((r) => (r.title || '').includes('/echo'));
                      const stored = JSON.parse(localStorage.getItem('barang:bolt-v1') || '{}');
                      const nCols = (stored.collections || []).length;
                      const nReqs = (stored.collections || []).reduce((a, c) => a + (c.requests || []).length, 0);
                      if (!row) e2e = 'not-in-sidebar:rows=' + allRows.length + ' cols=' + nCols + ' reqs=' + nReqs;
                      else {
                        const stored = JSON.parse(localStorage.getItem('barang:bolt-v1') || '{}');
                        const persisted = (stored.collections || []).some((c) => (c.requests || []).some((r) => (r.url || '').includes('/echo')));
                        if (!persisted) e2e = 'not-persisted';
                        else {
                          const syncBtn = document.querySelector('.bolt-foot .btn');
                          if (!syncBtn) e2e = 'no-sync-btn';
                          else {
                            syncBtn.click();
                            await sleep(1500);
                            let mirrored = 'missing';
                            try {
                              const f = await window.barang.fs.read('.barang/bolt/my-collection.json');
                              mirrored = f.content.includes('bolt-e2e-marker') ? 'ok' : 'no-marker';
                            } catch (e2) { mirrored = 'read-err'; }
                            const histOk = document.querySelectorAll('#view-api .bolt-hist-row').length > 0;
                            e2e = (mirrored === 'ok' && histOk) ? 'ok' : ('mirror=' + mirrored + ' hist=' + histOk);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } finally {
        try {
          if (lsBolt === null) localStorage.removeItem('barang:bolt-v1'); else localStorage.setItem('barang:bolt-v1', lsBolt);
          if (lsHist === null) localStorage.removeItem('barang:bolt-hist-v1'); else localStorage.setItem('barang:bolt-hist-v1', lsHist);
        } catch (e) {}
        try {
          if (!mirrorHad) { await window.barang.fs.remove('.barang/bolt/my-collection.json'); }
          else if (mirrorBefore !== null) { await window.barang.fs.write('.barang/bolt/my-collection.json', mirrorBefore); }
        } catch (e) {}
      }
      return 'e2e:' + e2e;
    } catch (e) {
      return 'INNER-ERR:' + (e.message || e);
    }
    })(${boltPort})`);
  } catch (e) { boltE2e = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] bolt: ' + boltE2e);
  pass = pass && /e2e:ok$/.test(boltE2e) && !/unit-FAIL/.test(boltE2e);
  try { boltSrv.close(); } catch {}
  // Cost meter: pure formatting/aggregation + statusbar presence.
  let costMeter = 'skip';
  try {
    costMeter = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || !u.fmtTokens || !u.sessionUsage) return 'no-utils';
      const bad = [];
      if (u.fmtTokens(999) !== '999') bad.push('f999');
      if (u.fmtTokens(0) !== '0') bad.push('f0');
      if (u.fmtTokens(1500) !== '1.5K') bad.push('f1.5K');
      if (u.fmtTokens(652219) !== '652K') bad.push('f652K');
      if (u.fmtTokens(12035577) !== '12.0M') bad.push('f12M');
      if (u.sessionUsage(undefined) !== null) bad.push('u-undef');      if (u.sessionUsage(null) !== null) bad.push('u-null');
      if (u.sessionUsage({ id: 'x' }) !== null) bad.push('u-empty');
      const t = u.sessionUsage({ id: 'x', tokens: { input: 1000, output: 500, reasoning: 0 }, cost: 0 });
      if (!t || t.tokens !== 1500 || t.label !== '1.5K') bad.push('u-basic');
      const c = u.sessionUsage({ id: 'x', tokens: { input: 100, output: 100, cache: { read: 999999 } }, cost: 0 });
      if (!c || c.tokens !== 200) bad.push('u-cache-excluded');
      const d = u.sessionUsage({ id: 'x', tokens: { input: 10, output: 5 }, cost: 1.5 });
      if (!d || d.label !== '$1.50') bad.push('u-cost-label');
      const uc = u.usageCard;
      if (typeof uc !== 'function') bad.push('no-card-fn');
      else {
        if (uc(undefined) !== null || uc({ id: 'x' }) !== null) bad.push('card-empty');
        const k = uc({ id: 'x', title: 'Logo', tokens: { input: 200000, output: 100000, reasoning: 50397, cache: { read: 10, write: 20 } }, cost: 0, time: { updated: Date.now() - 60000 } }, 'opencode/mimo', 42, 1000000);
        if (!k) bad.push('card-null');
        else {
          if (k.tokens !== '350,397') bad.push('card-tokens:' + k.tokens);
          if (k.cost !== '$0.00') bad.push('card-cost');
          if (k.pct !== 35) bad.push('card-pct:' + k.pct);
          if (k.limit !== 1000000) bad.push('card-limit');
          if (k.input !== '200,000' || k.output !== '100,000' || k.reasoning !== '50,397') bad.push('card-rows');
          if (k.cache !== '10/20') bad.push('card-cache');
          if (k.messages !== 42 || k.model !== 'opencode/mimo' || k.title !== 'Logo') bad.push('card-meta');
          if (k.updated !== '1m ago') bad.push('card-updated:' + k.updated);
        }
        const kn = uc({ id: 'x', tokens: { input: 5, output: 5 }, cost: 0 }, 'auto model', 1, null);
        if (!kn || kn.pct !== null) bad.push('card-nolimit');
      }
      // Composer history: cursor math + live Up/Down walk (seeded, cleaned).
      const sh = u.stepHistory;
      if (typeof sh !== 'function' || typeof u.pushComposerHist !== 'function') bad.push('no-hist-fns');
      else {
        if (sh(0, -1, 'up') !== -1) bad.push('hist-empty');
        if (sh(3, -1, 'up') !== 2 || sh(3, 2, 'up') !== 1 || sh(3, 0, 'up') !== 0) bad.push('hist-up');
        if (sh(3, -1, 'down') !== -1 || sh(3, 1, 'down') !== 2 || sh(3, 2, 'down') !== -1) bad.push('hist-down');
      }
      if (bad.length) return 'unit-FAIL:' + bad.join(';');
      const meter = document.querySelector('.status-usage');
      if (!meter) return 'no-meter-el';
      // Hover card: element exists; shows only when the meter has data.
      meter.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const card = document.querySelector('.usage-card');
      if (!card) return 'no-card-el';
      const meterHidden = meter.classList.contains('hidden');
      const cardVisible = card.classList.contains('visible');
      if (!meterHidden && !cardVisible) return 'card-not-shown';
      if (meterHidden && cardVisible) return 'card-shown-empty';
      if (cardVisible) {
        const txt = card.textContent || '';
        if (!/Cost/.test(txt) || !/Usage/.test(txt) || !/Tokens/.test(txt)) return 'card-rows-missing';
      }
      meter.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      return 'ok';
    })()`);
  } catch (e) { costMeter = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] cost-meter: ' + costMeter);
  pass = pass && costMeter === 'ok';
  // Updater visibility: the topbar button mirrors checkUpdates truthfully.
  // Effort dropdown: composer select exists with at least Default.
  let updateVis = 'skip';
  try {
    updateVis = await w.webContents.executeJavaScript(`(async () => {
      const info = await window.barang.app.checkUpdates().catch(() => null);
      if (!info) return 'no-info';
      const btn = document.querySelector('.topbar .update-btn');
      if (!btn) return 'no-btn';
      for (let i = 0; i < 20; i++) {
        const shown = !btn.classList.contains('hidden');
        if (shown === !!info.update) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const shown = !btn.classList.contains('hidden');
      if (shown !== !!info.update) return 'mismatch:update=' + info.update;
      // Replace-my-original target: discoverable in packaged builds, null in dev.
      if (!('replaceTarget' in info)) return 'no-replace-field';
      if (info.replaceTarget !== null) return 'replace-nonnull-dev:' + info.replaceTarget;
      const eff = document.querySelector('.composer .effort-mini');
      if (!eff) return 'no-effort';
      if (eff.querySelectorAll('option').length < 1) return 'effort-no-opts';
      if (![...eff.options].some((o) => o.value === '' && /default/i.test(o.textContent || ''))) return 'effort-no-default';
      const u = window.__barangTestUtils;
      if (!u || typeof u.resolveSendVariant !== 'function') return 'no-variant-fn';
      const bad = [];
      const cat = [{ providerID: 'opencode', modelID: 'spark', variants: ['low', 'high'] }, { providerID: 'x', modelID: 'y' }];
      const m = { providerID: 'opencode', modelID: 'spark' };
      if (u.resolveSendVariant(m, 'low', cat) !== 'low') bad.push('v-hit');
      if (u.resolveSendVariant(m, 'medium', cat) !== undefined) bad.push('v-miss');
      if (u.resolveSendVariant(m, null, cat) !== undefined) bad.push('v-null');
      if (u.resolveSendVariant(null, 'low', cat) !== undefined) bad.push('v-nomodel');
      if (u.resolveSendVariant({ providerID: 'x', modelID: 'y' }, 'low', cat) !== undefined) bad.push('v-nolist');
      if (u.resolveSendVariant(m, 'low', []) !== undefined) bad.push('v-emptycat');
      if (bad.length) return 'unit-FAIL:' + bad.join(';');
      return 'ok';
    })()`);
  } catch (e) { updateVis = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] update-vis: ' + updateVis);
  pass = pass && updateVis === 'ok';
  // Slash commands: server list shapes, composer suggest, unknown stays put.
  let slashCmd = 'skip';
  try {
    slashCmd = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.parseSlashCommand !== 'function' || typeof u.loadCommands !== 'function') return 'no-cmd-fns';
      const bad = [];
      const p1 = u.parseSlashCommand('/compact');
      if (!p1 || p1.name !== 'compact' || p1.args !== '') bad.push('parse-bare');
      const p2 = u.parseSlashCommand('/init focus area');
      if (!p2 || p2.name !== 'init' || p2.args !== 'focus area') bad.push('parse-args');
      if (u.parseSlashCommand('hello') !== null || u.parseSlashCommand('/ spaced') !== null || u.parseSlashCommand('') !== null) bad.push('parse-no');
      if (bad.length) return 'unit-FAIL:' + bad.join(';');
      const list = await u.loadCommands().catch(() => null);
      if (!Array.isArray(list)) return 'cmd-not-array';
      if (list.some((c) => !c || typeof c.name !== 'string' || !c.name)) return 'cmd-nameless';
      const input = document.querySelector('.composer-input');
      if (!input) return 'no-composer';
      const fireInput = () => input.dispatchEvent(new Event('input', { bubbles: true }));
      // Known prefix suggests; unknown keeps text + error toast on send.
      input.focus();
      input.value = '/in';
      fireInput();
      await new Promise((r) => setTimeout(r, 1500));
      const sug = document.querySelector('.suggest');
      const items = [...(sug?.querySelectorAll('.suggest-item') ?? [])].map((b) => (b.textContent || '').trim());
      if (sug && !sug.classList.contains('hidden')) {
        if (!items.some((t) => t.startsWith('/in'))) return 'suggest-wrong:' + items.slice(0, 3).join('|');
      }
      input.value = '/nope-cmd-xyz';
      fireInput();
      await new Promise((r) => setTimeout(r, 900));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 1500));
      if (input.value !== '/nope-cmd-xyz') return 'unknown-cleared';
      const toast = [...document.querySelectorAll('#toasts .toast.is-error')].map((t) => t.textContent || '').join(' ');
      if (!/Unknown command/.test(toast)) return 'unknown-no-toast';
      return 'ok';
    })()`);
  } catch (e) { slashCmd = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] slash-cmd: ' + slashCmd);
  pass = pass && slashCmd === 'ok';
  // Composer history: Up/Down walks submitted lines (seeded, then cleaned).
  // Residue-proof: older entries may precede the seeds, so the probe
  // asserts transitions (up-ends-stable, down-returns) not positions.
  let histWalk = 'skip';
  try {
    histWalk = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.pushComposerHist !== 'function') return 'no-push-fn';
      const KEY = 'barang:composer-history-v1';
      let saved = null;
      try { saved = localStorage.getItem(KEY); } catch {}
      const input = document.querySelector('.composer-input');
      if (!input) return 'no-composer';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        u.pushComposerHist('/compact');
        u.pushComposerHist('hello world');
        const press = (key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        press('ArrowUp'); await sleep(150);
        if (input.value !== 'hello world') return 'walk-1:' + input.value;
        press('ArrowUp'); await sleep(150);
        const v2 = input.value;
        if (v2 !== '/compact') return 'walk-2:' + v2;
        let top = v2, guard = 0;
        while (guard++ < 12) {
          press('ArrowUp'); await sleep(120);
          if (input.value === top) break;
          top = input.value;
        }
        if (input.value !== top) return 'walk-unstable';
        // Down to the newest seed and past it into the draft: residue copies
        // may repeat, so run to a STABLE empty draft instead of first sight.
        let sawHello = false, v = top, guard2 = 0;
        while (guard2++ < 16) {
          press('ArrowDown'); await sleep(120);
          v = input.value;
          if (v === 'hello world') sawHello = true;
          if (v === '' && sawHello) break;
        }
        if (!sawHello) return 'walk-back:' + JSON.stringify(v);
        if (v !== '') return 'walk-nodraft:' + JSON.stringify(v);
        press('ArrowDown'); await sleep(120);
        if (input.value !== '') return 'walk-draft:' + JSON.stringify(input.value);
        // Gated: arrows with text present leave it alone (cursor moves).
        input.value = 'typing here';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(150);
        press('ArrowUp'); await sleep(150);
        if (input.value !== 'typing here') return 'gated-fail:' + JSON.stringify(input.value);
        press('ArrowDown'); await sleep(150);
        if (input.value !== 'typing here') return 'gated-down-fail:' + JSON.stringify(input.value);
        input.value = '';
        return 'ok';
      } finally {
        try {
          if (saved === null) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, saved);
        } catch {}
        input.value = '';
      }
    })()`);
  } catch (e) { histWalk = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] hist-walk: ' + histWalk);
  pass = pass && histWalk === 'ok';
  // Live file tree: backend writes must appear with no manual refresh.
  let fileWatch = 'skip';
  try {
    fileWatch = await w.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const seen = () => [...document.querySelectorAll('.tree-label')].some((b) => (b.textContent || '').includes('filewatch-probe.txt'));
      try { await window.barang.fs.remove('filewatch-probe.txt'); } catch {}
      await sleep(1200);
      try { await window.barang.fs.write('filewatch-probe.txt', 'watch-me'); } catch (e) { return 'write-fail'; }
      let ok = false;
      for (let i = 0; i < 16 && !ok; i++) {
        await sleep(500);
        ok = seen();
      }
      if (!ok) return 'no-auto-refresh';
      try { await window.barang.fs.remove('filewatch-probe.txt'); } catch {}
      let gone = false;
      for (let i = 0; i < 16 && !gone; i++) {
        await sleep(500);
        gone = !seen();
      }
      if (!gone) return 'no-auto-remove';
      return 'ok';
    })()`);
  } catch (e) { fileWatch = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] file-watch: ' + fileWatch);
  pass = pass && fileWatch === 'ok';
  // Search hits land highlighted in the open file (all matches + current).
  let searchHl = 'skip';
  try {
    searchHl = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.revealSearchMatch !== 'function' || typeof u.getSearchDecorCount !== 'function') return 'no-hl-fns';
      try {
        await window.barang.fs.write('search-hl-probe.txt', 'alpha line\\nneedle here needle\\nomega line\\n');
      } catch (e) { return 'write-fail'; }
      await u.revealSearchMatch('search-hl-probe.txt', 2, 'needle', { regex: false, caseSensitive: true });
      await new Promise((r) => setTimeout(r, 900));
      if (u.getSearchDecorCount() < 2) return 'no-decor';
      const tab = document.querySelector('.tab[data-path="search-hl-probe.txt"]');
      if (!tab) return 'no-tab';
      // Switching tabs drops the highlights.
      await u.openFile('package.json');
      await new Promise((r) => setTimeout(r, 400));
      if (u.getSearchDecorCount() !== 0) return 'decor-survives-switch';
      if (typeof u.closeTab === 'function') await u.closeTab('package.json');
      // Clearing the query drops the highlights (the reported bug).
      await u.revealSearchMatch('search-hl-probe.txt', 2, 'needle', { regex: false, caseSensitive: true });
      await new Promise((r) => setTimeout(r, 600));
      if (u.getSearchDecorCount() < 2) return 'no-decor-again';
      const q = document.querySelector('#view-search .search-input[placeholder^="Search files"]');
      if (!q) return 'no-search-input';
      q.focus();
      q.value = '';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1000));
      if (u.getSearchDecorCount() !== 0) return 'decor-survives-clear';
      await u.revealSearchMatch('search-hl-probe.txt', 1, 'zzz-no-match', { regex: false, caseSensitive: true });
      await new Promise((r) => setTimeout(r, 400));
      if (u.getSearchDecorCount() !== 0) return 'decor-not-cleared';
      try { await window.barang.fs.remove('search-hl-probe.txt'); } catch {}
      if (typeof u.closeTab === 'function') await u.closeTab('search-hl-probe.txt');
      return 'ok';
    })()`);
  } catch (e) { searchHl = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] search-hl: ' + searchHl);
  pass = pass && searchHl === 'ok';
  // Question wizard: one at a time, Next/Back, picks survive navigation.
  let questWiz = 'skip';
  try {
    questWiz = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.upsertQuestion !== 'function' || typeof u.removeQuestion !== 'function') return 'no-quest-fns';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const props = {
        id: 'qwizard', sessionID: 'ses-wizard',
        questions: [
          { header: 'H1', question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
          { header: 'H2', question: 'Pick a size?', options: [{ label: 'Small' }, { label: 'Large' }] },
          { header: 'H3', question: 'Pick a shape?', options: [{ label: 'Round' }, { label: 'Square' }] },
        ],
        tool: {},
      };
      u.upsertQuestion(props);
      await sleep(600);
      const card = () => document.querySelector('.quest-card');
      const txt = () => (card()?.textContent || '');
      const title = () => (card()?.querySelector('.quest-title')?.textContent || '');
      if (!card()) return 'no-card';
      if (!/Question 1 of 3/.test(title())) return 'title-1:' + title();
      if (!txt().includes('Pick a color?')) return 'no-q1';
      if (txt().includes('Pick a size?') || txt().includes('Pick a shape?')) return 'all-visible';
      const next = () => [...(card()?.querySelectorAll('.quest-nav .btn') ?? [])].find((b) => b.textContent.trim() === 'Next');
      const back = () => [...(card()?.querySelectorAll('.quest-nav .btn') ?? [])].find((b) => b.textContent.trim() === 'Back');
      const pick = (label) => {
        const lab = [...(card()?.querySelectorAll('.quest-opt') ?? [])].find((l) => (l.textContent || '').includes(label));
        const radio = lab?.querySelector('input[type="radio"]');
        if (!radio) return false;
        radio.click();
        return radio.checked;
      };
      if (!pick('Blue')) return 'pick-fail';
      if (!next()) return 'no-next';
      next().click();
      await sleep(400);
      if (!/Question 2 of 3/.test(title())) return 'title-2:' + title();
      if (!txt().includes('Pick a size?') || txt().includes('Pick a color?')) return 'step-2-wrong';
      if (!pick('Large')) return 'pick2-fail';
      if (!next()) return 'no-next2';
      next().click();
      await sleep(400);
      if (!/Question 3 of 3/.test(title()) || !txt().includes('Pick a shape?')) return 'step-3-wrong';
      if (!back()) return 'no-back';
      back().click();
      await sleep(400);
      if (!/Question 2 of 3/.test(title())) return 'back-wrong';
      const still = [...(card()?.querySelectorAll('.quest-opt') ?? [])].find((l) => (l.textContent || '').includes('Large'))?.querySelector('input');
      if (!still || !still.checked) return 'pick-lost';
      if (!back()) return 'no-back2';
      back().click();
      await sleep(400);
      const still1 = [...(card()?.querySelectorAll('.quest-opt') ?? [])].find((l) => (l.textContent || '').includes('Blue'))?.querySelector('input');
      if (!/Question 1 of 3/.test(title()) || !still1 || !still1.checked) return 'pick1-lost';
      u.removeQuestion('ses-wizard', 'qwizard');
      await sleep(400);
      if (document.querySelector('.quest-card')) return 'card-lingers';
      return 'ok';
    })()`);
  } catch (e) { questWiz = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] quest-wizard: ' + questWiz);
  pass = pass && questWiz === 'ok';
  // Split editor: toggle, per-group strips, open-in-other, auto-collapse.
  let splitEd = 'skip';
  try {
    splitEd = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.groupTabs !== 'function') return 'no-split-fns';
      const mixed = [{ path: 'a', group: 1 }, { path: 'b', group: 2 }, { path: 'c' }];
      if (u.groupTabs(mixed, 1).length !== 2 || u.groupTabs(mixed, 2).length !== 1) return 'unit-FAIL:groups';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const visibleStrips = () => [...document.querySelectorAll('.center .tabs')].filter((s) => !s.closest('.hidden'));
      const fileTab0 = [...document.querySelectorAll('.center .tabs .tab')].find((b) => !(b.dataset.path || '').startsWith('bolt:') && !b.classList.contains('is-diff'));
      if (!fileTab0) return 'no-file-tab';
      fileTab0.click();
      await sleep(600);
      if (visibleStrips().length !== 1) return 'no-single-strip';
      // Deterministic start: a real file tab active (bolt overlay would take
      // the whole center and hide the split by design).
      // Open via the strip button.
      const openBtn = document.querySelector('.split-btn');
      if (!openBtn) return 'no-split-btn';
      openBtn.click();
      await sleep(800);
      if (visibleStrips().length !== 2) {
        const snap = u.editorSplitState ? JSON.stringify(u.editorSplitState()) : 'no-snap-fn';
        return 'no-split-open state=' + snap;
      }
      // Split open mirrors the file into a real right tab (not a bare model).
      if (visibleStrips()[1].querySelectorAll('.tab').length < 1) return 'no-mirror-tab';
      const tab = [...document.querySelectorAll('.center .tabs .tab')].find((b) => !(b.dataset.path || '').startsWith('bolt:') && !b.classList.contains('is-diff'));
      if (!tab) return 'no-tab';
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 220 }));
      await sleep(500);
      const menu = document.querySelector('.ctx-menu');
      const item = [...(menu?.querySelectorAll('.ctx-item') ?? [])].find((b) => /Other Group|Split Right/.test(b.textContent || ''));
      if (!item) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return 'no-split-item:' + ((menu?.textContent || '').slice(0, 80));
      }
      item.click();
      await sleep(1500);
      const snap = u.editorSplitState ? JSON.stringify(u.editorSplitState()) : 'no-snap-fn';
      const counts = visibleStrips().map((s) => s.querySelectorAll('.tab').length);
      if (!(counts.length === 2 && counts[0] >= 1 && counts[1] >= 1)) return 'no-right-tab:' + counts.join(',') + ' state=' + snap;
      // Ctrl+W closes the focused (right) tab; last right tab collapses.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true, ctrlKey: true }));
      await sleep(1000);
      if (visibleStrips().length !== 1) {
        const c = visibleStrips().map((s) => s.querySelectorAll('.tab').length);
        return 'no-collapse:' + c.join(',');
      }
      // Ctrl+\ reopens (keybinding path), Ctrl+\ again closes (toggle).
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', bubbles: true, cancelable: true, ctrlKey: true }));
      await sleep(800);
      if (visibleStrips().length !== 2) return 'no-key-open';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', bubbles: true, cancelable: true, ctrlKey: true }));
      await sleep(800);
      if (visibleStrips().length !== 1) return 'no-key-close';
      return 'ok';
    })()`);
  } catch (e) { splitEd = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] split-editor: ' + splitEd);
  pass = pass && splitEd === 'ok';
  // Pomodoro: rail tab opens the view, Start ticks, Reset idles.
  let pomoUi = 'skip';
  try {
    pomoUi = await w.webContents.executeJavaScript(`(async () => {
      const rail = [...document.querySelectorAll('.side-viewbar .side-view-btn')];
      if (rail.length !== 5) return 'rail-count:' + rail.length;
      const btn = rail.find((b) => (b.title || '').toLowerCase().includes('pomodoro'));
      if (!btn) return 'no-pomo-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
      const host = document.querySelector('#view-pomo');
      if (!host || host.classList.contains('hidden')) return 'pomo-not-open';
      if (!host.querySelector('.pomo-ring') || !host.querySelector('.pomo-clock')) return 'pomo-no-ring';
      const steps = host.querySelectorAll('.pomo-stepper').length;
      const toggles = host.querySelectorAll('.switch-input').length;
      if (steps < 4 || toggles < 4) return 'pomo-settings-thin:' + steps + '/' + toggles;
      const start = [...host.querySelectorAll('.pomo-btns .btn')].find((b) => /^(start|continue)$/i.test((b.textContent || '').trim()));
      if (!start) return 'no-start-btn';
      start.click();
      await new Promise((r) => setTimeout(r, 1600));
      const clock = host.querySelector('.pomo-clock')?.textContent ?? '';
      if (!/^\\d+:\\d\\d$/.test(clock)) return 'bad-clock:' + clock;
      const meter = document.querySelector('.status-pomo');
      if (!meter || meter.classList.contains('hidden')) return 'no-status-pomo';
      const reset = [...host.querySelectorAll('.pomo-btns .btn')].find((b) => /^reset$/i.test((b.textContent || '').trim()));
      if (!reset) return 'no-reset-btn';
      reset.click();
      await new Promise((r) => setTimeout(r, 400));
      return 'ok';
    })()`);
  } catch (e) { pomoUi = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] pomodoro: ' + pomoUi);
  pass = pass && pomoUi === 'ok';
  // MCP: section renders, config round-trips, live connect reports.
  let mcpUi = 'skip';
  try {
    mcpUi = await w.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.topbar .settings-btn')?.click();
      await sleep(700);
      const nav = [...document.querySelectorAll('.settings-overlay .settings-nav-item')].find((b) => b.textContent === 'MCP');
      if (!nav) return 'no-mcp-nav';
      nav.click();
      await sleep(1800);
      const sec = document.querySelector('.settings-overlay #sec-mcp');
      if (!sec) return 'no-mcp-sec';
      const box = sec.parentElement?.querySelector('.mcp-box') ?? document.querySelector('.settings-overlay .mcp-box');
      if (!box) return 'no-mcp-box';
      const u = window.__barangTestUtils;
      if (!u || typeof u.buildFileText !== 'function') return 'no-mcp-utils';
      let orig = null;
      try {
        const r0 = await window.barang.mcpConfig('read', { scope: 'managed' });
        orig = r0?.text ?? null;
        const text = u.buildFileText(orig ?? '', { 'barang-smoke': { type: 'remote', url: 'https://example.invalid/mcp', oauth: false } });
        await window.barang.mcpConfig('write', { scope: 'managed', text });
        const r1 = await window.barang.mcpConfig('read', { scope: 'managed' });
        if (!(r1?.text || '').includes('barang-smoke')) return 'roundtrip-missing';
        await window.barang.oc('/mcp', { method: 'POST', body: { name: 'barang-smoke', config: { type: 'remote', url: 'https://example.invalid/mcp', oauth: false } } }).catch(() => null);
        await sleep(2500);
        const live = await window.barang.oc('/mcp').catch(() => ({}));
        const st = live && live['barang-smoke'] ? String(live['barang-smoke'].status || '') : '';
        if (st !== '' && st !== 'failed') return 'live-unexpected:' + st;
        return 'ok';
      } finally {
        try {
          if (orig) await window.barang.mcpConfig('write', { scope: 'managed', text: orig });
          else await window.barang.mcpConfig('write', { scope: 'managed', text: '{"$schema":"https://opencode.ai/config.json","mcp":{}}' });
        } catch {}
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
    })()`);
  } catch (e) { mcpUi = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] mcp-e2e: ' + mcpUi);
  pass = pass && mcpUi === 'ok';
  // Preview tabs: markdown renders h1, images render data URL, both close.
  let previewTabs = 'skip';
  try {
    previewTabs = await w.webContents.executeJavaScript(`(async () => {
      const u = window.__barangTestUtils;
      if (!u || typeof u.openPreview !== 'function' || typeof u.openFile !== 'function') return 'no-preview-fns';
      const f = u.getEditorDisplayFlags ? u.getEditorDisplayFlags() : null;
      if (!f || f.brackets !== true || f.sticky !== true) return 'flags-off';
      await u.openPreview('README.md');
      await new Promise((r) => setTimeout(r, 900));
      const prev = document.querySelector('.md-preview');
      if (!prev || !prev.querySelector('h1')) return 'no-preview-h1';
      await u.openFile('Barang_logo.png');
      await new Promise((r) => setTimeout(r, 900));
      const img = document.querySelector('.img-preview');
      if (!img || (img.src || '').indexOf('data:image/') !== 0) return 'no-image';
      if (typeof u.closeTab !== 'function') return 'no-close-fn';
      const pre = u.editorSplitState ? JSON.stringify(u.editorSplitState()) : 'no-snap';
      const tabDump = [...document.querySelectorAll('.center .tabs .tab')].map((b) => b.dataset.path + '@' + (b.closest('.split-col') ? 'split' : 'main')).join(',');
      await u.closeTab('preview:README.md');
      await new Promise((r) => setTimeout(r, 400));
      await u.closeTab('Barang_logo.png');
      await new Promise((r) => setTimeout(r, 400));
      const post = u.editorSplitState ? JSON.stringify(u.editorSplitState()) : 'no-snap';
      const stripDump = [...document.querySelectorAll('.center .tabs')].map((s) => {
        const hid = !!s.closest('.hidden');
        const act = s.querySelector('.tab.active');
        return 'hidden=' + hid + ' active=' + (act ? act.dataset.path : 'none') + ' tabs=[' + [...s.querySelectorAll('.tab')].map((x) => x.dataset.path).join('+') + ']';
      }).join(' // ');
      const colsHidden = !!document.querySelector('.editor-cols.hidden');
      const boltHidden = !!document.querySelector('#bolt-host.hidden');
      const left = [...document.querySelectorAll('.tab')].filter((b) => ['preview:README.md', 'Barang_logo.png'].indexOf(b.dataset.path) >= 0);
      if (left.length) return 'tabs-linger:' + left.length + ' colsHidden=' + colsHidden + ' boltHidden=' + boltHidden + ' strips={' + stripDump + '}';
      return 'ok';
    })()`);
  } catch (e) { previewTabs = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] preview-tabs: ' + previewTabs);
  pass = pass && previewTabs === 'ok';
  // Search-replace E2E (hermetic throwaway dir in the project). The marker
  // is timestamp-unique per run so the harness's own source (which mentions
  // the queries) can never collide with the scanned content.
  let replaceE2e = 'skip';
  try {
    replaceE2e = await w.webContents.executeJavaScript(`(async () => {
      const dir = 'replace-probe';
      const M = 'zzq' + Date.now().toString(36);
      try { await window.barang.fs.remove(dir); } catch (e) {}
      await window.barang.fs.write(dir + '/a.txt', M + ' one\\n' + M + ' two\\n');
      await window.barang.fs.write(dir + '/b.txt', 'nothing here\\n');
      await window.barang.fs.write(dir + '/c.txt', M + '\\n' + M + '\\n' + M + '\\n');
      await window.barang.fs.write(dir + '/d.txt', M + '.q ' + M + 'xq\\n');
      const api = window.barang.fs.searchReplace;
      const dry = await api({ q: M, replacement: M + 'y', dryRun: true });
      if (!(dry.totalMatches === 7 && dry.totalFiles === 3)) return 'dry:' + dry.totalMatches + '/' + dry.totalFiles;
      const lit = await api({ q: M + '.q', replacement: 'X', dryRun: true });
      if (lit.totalMatches !== 1) return 'literal-escape:' + lit.totalMatches;
      const rx = await api({ q: M + '+', replacement: 'Q', regex: true, dryRun: true });
      if (rx.totalMatches !== 7) return 'regex:' + rx.totalMatches;
      try {
        await api({ q: '([', replacement: 'x', regex: true, dryRun: true });
        return 'invalid-no-throw';
      } catch (e) {
        if (!/nvalid|egex/i.test(e.message || '')) return 'invalid-msg';
      }
      const done = await api({ q: M, replacement: M + 'y', dryRun: false });
      if (!(done.totalMatches === 7 && done.totalFiles === 3)) return 'apply-counts';
      const a = await window.barang.fs.read(dir + '/a.txt');
      const c = await window.barang.fs.read(dir + '/c.txt');
      const b = await window.barang.fs.read(dir + '/b.txt');
      if (a.content !== M + 'y one\\n' + M + 'y two\\n') return 'apply-a';
      if (c.content !== M + 'y\\n' + M + 'y\\n' + M + 'y\\n') return 'apply-c';
      if (!b.content.includes('nothing')) return 'apply-b-touched';
      try { await window.barang.fs.remove(dir); } catch (e) {}
      return 'ok';
    })()`);
  } catch (e) { replaceE2e = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] replace-e2e: ' + replaceE2e);
  pass = pass && replaceE2e === 'ok';
  // Search view E2E (scoped throwaway dir): open view, query, include /
  // exclude scope, highlight, per-file replace, global replace, cleanup.
  let searchUi = 'skip';
  try {
    searchUi = await w.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const dir = 'searchview-probe';
      const M = 'svq' + Date.now().toString(36);
      // NOTE: R must NOT contain M (else rescans re-match replaced text).
      const R = 'rep' + Date.now().toString(36) + 'zz';
      const AQ = (s) => document.querySelector(s);
      const AQA = (s) => [...document.querySelectorAll(s)];
      try { await window.barang.fs.remove(dir); } catch (e) {}
      await window.barang.fs.write(dir + '/a.txt', M + ' one\\n' + M + ' two\\n');
      await window.barang.fs.write(dir + '/sub/b.txt', M + '\\n' + M + '\\n' + M + '\\n');
      await window.barang.fs.write(dir + '/ind.txt', '    ' + M + ' padded\\n\\t' + M + '\\n');
      const vb = AQ('[title="Search (Ctrl+Shift+F)"]');
      if (!vb) return 'no-view-btn';
      vb.click();
      await sleep(600);
      if (AQ('#view-search')?.classList.contains('hidden')) return 'view-did-not-open';
      const inputs = AQA('#view-search .search-input');
      if (inputs.length < 4) return 'inputs:' + inputs.length;
      // Replace input is always visible (no toggle to lose it behind).
      const repRowVisible = (() => {
        const r = inputs[1].closest('.search-row');
        return !!r && !r.classList.contains('hidden') && r.getBoundingClientRect().height > 0;
      })();
      if (!repRowVisible) return 'replace-hidden';
      const q = inputs[0];
      q.value = M;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      const headText = async () => {
        for (let i = 0; i < 25; i++) {
          await sleep(300);
          const t = AQ('#view-search .search-count')?.textContent ?? '';
          if (/7 results? in 3 files/.test(t)) return t;
        }
        return AQ('#view-search .search-count')?.textContent ?? 'none';
      };
      let head = await headText();
      if (!/7 results? in 3 files/.test(head)) return 'no-results:' + head;
      const rows = AQA('#view-search .search-match').length;
      if (rows < 7) return 'rows:' + rows;
      if (!AQA('#view-search .search-preview mark').length) return 'no-highlight';
      // Highlight POSITION: every mark must be exactly the query — catches
      // offset drift on indented lines (backend offsets vs trimmed preview).
      const marks = AQA('#view-search .search-preview mark').map((n) => n.textContent);
      const badMarks = marks.filter((t) => t !== M);
      if (!marks.length || badMarks.length) return 'highlight-pos:' + JSON.stringify(badMarks.slice(0, 3));
      // include scope (subdir only) then exclude scope (top file only)
      inputs[2].value = dir + '/sub';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      let h2 = '';
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        h2 = AQ('#view-search .search-count')?.textContent ?? '';
        if (/3 results? in 1 file/.test(h2)) break;
      }
      if (!/3 results? in 1 file/.test(h2)) return 'include-scope:' + h2;
      inputs[2].value = '';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[3].value = 'sub';
      inputs[3].dispatchEvent(new Event('input', { bubbles: true }));
      let h3 = '';
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        h3 = AQ('#view-search .search-count')?.textContent ?? '';
        if (/4 results? in 2 files/.test(h3)) break;
      }
      if (!/4 results? in 2 files/.test(h3)) return 'exclude-scope:' + h3;
      inputs[3].value = '';
      inputs[3].dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1500);
      // replacement + per-file replace on a.txt
      inputs[1].value = R;
      const secA = AQA('#view-search .search-file').find((s) => (s.querySelector('.search-file-name')?.textContent || '').includes('a.txt'));
      if (!secA) return 'no-file-sec';
      const repBtn = secA.querySelector('[title^="Replace all in"]');
      if (!repBtn) return 'no-rep-btn';
      repBtn.click();
      let modalSeen = false;
      for (let i = 0; i < 25 && !modalSeen; i++) {
        await sleep(400);
        modalSeen = !!AQ('.confirm-modal');
      }
      if (!modalSeen) return 'no-confirm';
      AQ('.confirm-modal .btn-danger')?.click();
      let h4 = '';
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        h4 = AQ('#view-search .search-count')?.textContent ?? '';
        if (/5 results? in 2 files/.test(h4)) break;
      }
      if (!/5 results? in 2 files/.test(h4)) return 'per-file-replace:' + h4;
      const fa = await window.barang.fs.read(dir + '/a.txt');
      if (fa.content !== R + ' one\\n' + R + ' two\\n') return 'per-file-content';
      // global replace all for the rest
      const allBtn = AQ('#view-search .search-results-head .btn');
      if (!allBtn) return 'no-all-btn';
      allBtn.click();
      let modalSeen2 = false;
      for (let i = 0; i < 25 && !modalSeen2; i++) {
        await sleep(400);
        modalSeen2 = !!AQ('.confirm-modal');
      }
      if (!modalSeen2) return 'no-confirm-2';
      AQ('.confirm-modal .btn-danger')?.click();
      let h5 = '';
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        h5 = AQ('#view-search .search-count')?.textContent ?? '';
        if (/0 results? in 0 files/.test(h5)) break;
      }
      if (!/0 results? in 0 files/.test(h5)) return 'global-replace:' + h5;
      const fb = await window.barang.fs.read(dir + '/sub/b.txt');
      if (fb.content !== R + '\\n' + R + '\\n' + R + '\\n') return 'global-content';
      try { await window.barang.fs.remove(dir); } catch (e) {}
      return 'ok';
    })()`);
  } catch (e) { searchUi = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] search-ui: ' + searchUi);
  pass = pass && searchUi === 'ok';
  console.log(`[smoke-ui] ${pass ? 'PASS' : 'FAIL'}`);
  stopServer();
  // Drain stdout/file pipes before exiting — GUI-subsystem exits otherwise
  // truncate trailing log lines nondeterministically.
  await new Promise((r) => setTimeout(r, 800));
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
    watchProject(root);
    if (SMOKE || SMOKE_UI) {
      // Smoke harnesses need the server up first (probes assert against it).
      try {
        await bootOpencode();
        bootLog('opencode-ready', JSON.stringify(opencodeState()));
      } catch (e) {
        bootLog('opencode-failed', e.message);
        console.error('[barang] ' + e.message);
      }
      if (SMOKE) {
        bootLog('smoke-start');
        await runMainSmoke();
        return;
      }
      await runUiSmoke();
      return;
    }
    applyNoMenu();
    createWindow();
    bootLog('window-open');
    // Pending self-update replace (written by the previous version's
    // apply-update): copy the download over the user's original exe once
    // it lets go, then report back over the progress channel. Fire and
    // forget — boot must never wait on it.
    void handlePendingReplace().catch((e) => bootLog('replace-failed', e?.message || String(e)));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    // Fresh-PC lag lived here: the window used to wait for extraction +
    // AV scan + cold Bun start (up to a minute of blank screen). Now the
    // window opens first and the server follows; the UI already handles
    // offline (banner) and flips online on opencode:ready.
    void bootOpencode().then(
      () => {
        bootLog('opencode-ready', JSON.stringify(opencodeState()));
        broadcast('opencode:ready', { root });
      },
      (e) => {
        const msg = e?.message || String(e);
        bootLog('opencode-failed', msg);
        console.error('[barang] ' + msg);
        broadcast('opencode:error', { error: msg });
      },
    );
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    term.killAll(); // shells die with the window (VSCode behavior)
    stopServer(); // tree-kill the owned `opencode serve`
  });
}
