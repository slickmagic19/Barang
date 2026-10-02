// Preload: the ONLY bridge between the sandboxed renderer and Node.
// Minimal, no direct ipcRenderer exposure.
// NOTE: .cjs on purpose — sandboxed preloads load as classic scripts, so ESM
// `import` syntax fails here ("Cannot use import statement outside a module").
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (res && res.ok === false) {
    throw new Error(res.error || `${channel} failed`);
  }
  return res?.data ?? res;
}

const barang = {
  fs: {
    tree: (path = '.', depth = 1, all = false) => invoke('fs:tree', { path, depth, all }),
    read: (path) => invoke('fs:read', { path }),
    write: (path, content) => invoke('fs:write', { path, content }),
    mkdir: (path) => invoke('fs:mkdir', { path }),
    rename: (from, to) => invoke('fs:rename', { from, to }),
    remove: (path) => invoke('fs:remove', { path }),
    writeAbsolute: (path, content) => invoke('fs:write-absolute', { path, content }),
    readExternal: (path) => invoke('fs:read-external', { path }),
    find: (query, limit = 50) => invoke('fs:find', { query, limit }),
    search: (q, path = '', limit = 50) => invoke('fs:search', { q, path, limit }),
  },
  /** Raw opencode call. Resolves parsed JSON (or undefined) / throws Error. */
  oc: async (path, { method = 'GET', body } = {}) => {
    const res = await ipcRenderer.invoke('oc:call', { path, method, body });
    if (res.ok === false) throw new Error(res.error || 'opencode call failed');
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(res.text);
        if (parsed?.error) msg = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
        else if (parsed?.data?.message) msg = parsed.data.message;
      } catch {
        if (res.text) msg = res.text.slice(0, 300);
      }
      throw new Error(msg);
    }
    const text = res.text || '';
    return text ? JSON.parse(text) : undefined;
  },
  events: {
    /** Upstream /event frames forwarded by main. cb(dataString). */
    subscribe: (cb) => {
      const onEvent = (_ev, payload) => cb(payload?.data ?? '');
      ipcRenderer.on('opencode:event', onEvent);
      return () => ipcRenderer.removeListener('opencode:event', onEvent);
    },
    /** Connection-state listener. Returns unsubscribe. */
    onConn: (cb) => {
      const h = (_ev, payload) => cb(!!payload?.connected);
      ipcRenderer.on('opencode:conn', h);
      return () => ipcRenderer.removeListener('opencode:conn', h);
    },
  },
  term: {
    list: () => invoke('term:list'),
    defaultShell: () => invoke('term:default-shell'),
    create: (opts = {}) => invoke('term:create', opts),
    write: (id, data) => invoke('term:write', { id, data }),
    resize: (id, cols, rows) => invoke('term:resize', { id, cols, rows }),
    kill: (id) => invoke('term:kill', { id }),
    /** PTY output listener. cb({ id, data }). Returns unsubscribe. */
    onData: (cb) => {
      const h = (_ev, payload) => cb(payload);
      ipcRenderer.on('term:data', h);
      return () => ipcRenderer.removeListener('term:data', h);
    },
    /** PTY exit listener. cb({ id, code, signal }). Returns unsubscribe. */
    onExit: (cb) => {
      const h = (_ev, payload) => cb(payload);
      ipcRenderer.on('term:exit', h);
      return () => ipcRenderer.removeListener('term:exit', h);
    },
  },
  clip: {
    read: () => invoke('app:clip-read'),
    write: (text) => invoke('app:clip-write', { text }),
  },
  /** Source control: single channel, op dispatch (info/diff/stage/…/log/init). */
  git: (op, args = {}) => invoke('git:run', { op, args }),
  /** Bolt API client: main-process HTTP (no CORS), cancellable. */
  api: {
    send: (req) => invoke('api:send', req),
    cancel: (reqId) => invoke('api:cancel', { reqId }),
  },
  app: {
    state: () => ipcRenderer.invoke('app:state'),
    openFolder: () => invoke('app:open-folder'),
    openPath: (path) => invoke('app:open-path', { path }),
    setRestore: (restore) => invoke('app:set-restore', { restore }),
    checkUpdates: () => invoke('app:check-updates'),
    pickFiles: () => invoke('app:pick-files'),
    saveDialog: (defaultPath) => invoke('app:save-dialog', { defaultPath }),
    openExternal: (url) => invoke('app:open-external', { url }),
    retryOpencode: () => invoke('app:retry-opencode'),
    /** Windows toast + taskbar badge. Resolves { ok, count } (never throws). */
    notify: (n) => invoke('app:notify', n),
    clearAttention: () => invoke('app:clear-attention'),
    /** Custom notification sound picker (vaulted to userData). */
    pickSound: () => invoke('app:pick-sound'),
    /** Menu + root-change events. cb(kind, payload). */
    onMenu: (cb) => {
      const handlers = {
        'menu:toggle-agent': () => cb('toggle-agent'),
        'menu:palette': (_ev, prefill) => cb('palette', prefill),
        'menu:new-session': () => cb('new-session'),
        'app:root-changed': (_ev, payload) => cb('root-changed', payload),
        'opencode:ready': (_ev, payload) => cb('opencode:ready', payload),
        'opencode:error': (_ev, payload) => cb('opencode:error', payload),
      };
      for (const [ch, h] of Object.entries(handlers)) ipcRenderer.on(ch, h);
      return () => {
        for (const [ch, h] of Object.entries(handlers)) ipcRenderer.removeListener(ch, h);
      };
    },
  },
};

contextBridge.exposeInMainWorld('barang', barang);
