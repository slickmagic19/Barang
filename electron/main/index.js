// Barang desktop entry: single window, native menu, IPC backend.
// Backend = direct function calls (fs + owned opencode server). No HTTP ports,
// no auth in the UI: model credentials stay inside the user's opencode CLI.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as files from './files.js';
import { ensureServer, restartServer, stopServer, ocCall, opencodeState, attachPumpHandlers } from './opencodeClient.js';
import * as term from './terminal.js';
import * as scm from './git.js';

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
let root = process.env.BARANG_ROOT || ''; // '' = no project (welcome state)
let recents = []; // most-recent-first project roots (max 8)
let restoreProject = false; // Settings > Startup: reopen last project
let statePath = '';

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
  await ensureServer(cwd, { onLog: (line) => console.log(line.trimEnd()) });
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

/** Check slickmagic19/Barang releases for a newer tag. Never throws fatally
 *  (offline/blocked networks just report no update). */
async function checkForUpdates() {
  const now = Date.now();
  if (updateCache && now - updateCache.at < 3600000) return updateCache.info;
  const info = { update: false, current: app.getVersion() };
  try {
    const res = await fetch('https://api.github.com/slickmagic19/Barang/releases/latest', {
      headers: { 'user-agent': 'barang-updater', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    info.version = String(rel.tag_name || '');
    info.url = rel.html_url || '';
    info.update = !!latest && cmpVersions(latest, info.current) > 0;
  } catch (e) {
    info.error = e?.message || String(e);
  }
  updateCache = { at: now, info };
  return info;
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
  broadcast('app:root-changed', { root });
  restartServer(root, { onLog: (line) => console.log(line.trimEnd()) }).then(
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
  ipcMain.handle('fs:read', ok(needRoot((p) => files.readFile(root, p.path))));
  ipcMain.handle('fs:write', ok(needRoot((p) => files.writeFile(root, p.path, p.content))));
  ipcMain.handle('fs:mkdir', ok(needRoot((p) => files.mkdir(root, p.path))));
  ipcMain.handle('fs:rename', ok(needRoot((p) => files.renamePath(root, p.from, p.to))));
  ipcMain.handle('fs:remove', ok(needRoot((p) => files.removePath(root, p.path))));
  ipcMain.handle('fs:write-absolute', ok((p) => files.writeAbsolute(p.path, p.content, root)));
  ipcMain.handle('fs:read-external', ok((p) => files.readExternal(p.path)));
  ipcMain.handle('fs:find', ok(needRoot((p) => files.find(root, p))));
  ipcMain.handle('fs:search', ok(needRoot((p) => files.search(root, p))));

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
  ipcMain.handle('term:default-shell', ok(() => ({ shell: term.defaultShell(), label: term.shellLabel(term.defaultShell()) })));
  // Deterministic clipboard for the terminal (renderer clipboard API is
  // focus-gated; main-process electron.clipboard always works).
  ipcMain.handle('app:clip-read', ok(() => ({ text: clipboard.readText() })));
  ipcMain.handle('app:clip-write', ok((p = {}) => { clipboard.writeText(String(p.text ?? '')); return { ok: true }; }));
  // Terminal link clicks: http(s) only, opened in the OS browser.
  ipcMain.handle('app:open-external', ok((p = {}) => {
    const url = String(p.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
    void shell.openExternal(url);
    return { ok: true };
  }));
  // --- source control (single channel; op dispatch, project-root cwd) ---
  const gitOps = {
    info: (a) => scm.info(gitCwd()),
    diff: (a) => scm.fileDiff(gitCwd(), String(a.path || '')),
    stage: (a) => scm.stage(gitCwd(), [].concat(a.paths ?? [])),
    unstage: (a) => scm.unstage(gitCwd(), [].concat(a.paths ?? [])),
    discard: (a) => scm.discard(gitCwd(), [].concat(a.paths ?? [])),
    commit: (a) => scm.commit(gitCwd(), a.message, a.amend === true),
    branches: (a) => scm.branches(gitCwd()),
    checkout: (a) => scm.checkout(gitCwd(), String(a.name || '')),
    'create-branch': (a) => scm.createBranch(gitCwd(), String(a.name || '')),
    fetch: (a) => scm.fetchAll(gitCwd()),
    pull: (a) => scm.pull(gitCwd()),
    push: (a) => scm.push(gitCwd()),
    sync: (a) => scm.sync(gitCwd()),
    'stash-list': (a) => scm.stashList(gitCwd()),
    'stash-push': (a) => scm.stashPush(gitCwd(), a.message),
    'stash-pop': (a) => scm.stashPop(gitCwd()),
    'stash-drop': (a) => scm.stashDrop(gitCwd()),
    log: (a) => scm.log(gitCwd(), a.n),
    init: (a) => scm.init(gitCwd()),
  };
  const gitCwd = () => root || path.join(app.getPath('userData'), 'scratch');
  ipcMain.handle('git:run', ok(async (p = {}) => {
    const fn = gitOps[p.op];
    if (!fn) throw new Error(`Unknown git op: ${p.op}`);
    return fn(p.args ?? {});
  }));

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
  await check('git-status', async () => {
    // Barang's own folder is a git repo — status must resolve against it.
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
              await new Promise((rr) => setTimeout(rr, 600));
              // VSCode parity: the rename prompt must sit in place (inside
              // the sub-tree), not pinned to the top of the explorer.
              renamePlaced = !!q('.tree-sub .tree-prompt');
              const inp = document.querySelector('.tree-prompt-input');
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
        let untitled = 'skip';
        try {
          if (!document.querySelector('.monaco-editor')) { untitled = 'skip-no-monaco'; }
          else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
            await new Promise((rr) => setTimeout(rr, 800));
            const tab = [...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').includes('Untitled'));
            if (!tab) { untitled = 'no-tab'; }
            else {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
              await new Promise((rr) => setTimeout(rr, 800));
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
          ctxMenu, ctxItems, ctxClosed,
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
    dom.gutters === 2 && dom.panelsVisible === true && dom.welcomeHidden === true && dom.openSplit === true && dom.updateBtn === true && dom.noSessionLabel === true && dom.headerShadow === true && dom.icons >= 8 && dom.selects === 2 && dom.emoji === 0 &&
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
  // statusbar, open its diff tab, then clean up.
  let scmProbe = 'skip';
  try {
    scmProbe = await w.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.status-git');
      if (!btn || btn.classList.contains('hidden')) return 'skip-no-git-btn';
      await window.barang.fs.write('.barang-smoke-scm/probe.txt', 'v1');
      btn.click();
      await new Promise((r) => setTimeout(r, 3000));
      const scm = document.getElementById('view-scm');
      if (!scm || scm.classList.contains('hidden')) return 'scm-view-did-not-open';
      const branch = document.querySelector('.scm-branch span:not(.ic)')?.textContent?.trim() ?? '';
      const rows = document.querySelectorAll('.scm-row').length;
      const commit = !!document.querySelector('.scm-commit-btn');
      let diff = 'no-rows';
      const row = [...document.querySelectorAll('.scm-sec .scm-row')].find((r) => r.querySelector('.git-badge'));
      if (row) {
        row.click();
        await new Promise((r) => setTimeout(r, 2500));
        const tab = document.querySelector('.tab.is-diff');
        diff = tab ? 'ok' : 'no-diff-tab';
        tab?.querySelector('.tab-x')?.click();
        await new Promise((r) => setTimeout(r, 600));
      }
      try { await window.barang.fs.remove('.barang-smoke-scm'); } catch {}
      document.querySelector('.side-view-btn')?.click();
      return 'branch=' + branch + ' rows=' + rows + ' commit=' + commit + ' diff=' + diff;
    })()`);
  } catch (e) { scmProbe = 'error: ' + (e.message || e); }
  console.log('[smoke-ui] scm: ' + scmProbe);
  pass = pass && /^branch=\S+ rows=\d+ commit=true diff=ok$/.test(scmProbe);
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
    term.killAll(); // shells die with the window (VSCode behavior)
    stopServer(); // tree-kill the owned `opencode serve`
  });
}
