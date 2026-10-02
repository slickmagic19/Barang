// Desktop transport: typed access to the preload bridge (window.barang).
// Barang is a desktop app — there is intentionally no HTTP fallback. If this
// throws, the UI was opened outside Electron (e.g. a plain browser tab).
export interface FsBridge {
  tree(path?: string, depth?: number, all?: boolean): Promise<{ path: string; children: import('./api').FsEntry[] }>;
  read(path: string): Promise<{ path: string; content?: string; binary?: boolean; size: number; mtime?: number }>;
  write(path: string, content: string): Promise<{ ok: boolean; size: number; mtime: number }>;
  mkdir(path: string): Promise<{ ok: boolean; path: string }>;
  rename(from: string, to: string): Promise<{ ok: boolean; path: string }>;
  remove(path: string): Promise<{ ok: boolean; path: string }>;
  readExternal(path: string): Promise<{ ok: boolean; path: string; name: string; mime: string; size: number; base64: string }>;
  writeAbsolute(path: string, content: string): Promise<{ ok: boolean; path: string; rootRel: string | null; size: number; mtime: number }>;
  find(query: string, limit?: number): Promise<{ results: Array<{ path: string; score: number }> }>;
  search(q: string, path?: string, limit?: number): Promise<{
    results: Array<{ path: string; line: number; text: string }>;
    engine: string;
    truncated?: boolean;
  }>;
}

export interface BarangBridge {
  fs: FsBridge;
  oc(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown>;
  term: {
    list(): Promise<Array<{ id: string; pid: number | null; shell: string; cwd: string; dead: boolean; exitCode: number | null }>>;
    defaultShell(): Promise<{ shell: string; label: string }>;
    create(opts?: { shell?: string; cols?: number; rows?: number }): Promise<{ id: string; pid: number | null; shell: string; cwd: string }>;
    write(id: string, data: string): Promise<boolean>;
    resize(id: string, cols: number, rows: number): Promise<boolean>;
    kill(id: string): Promise<'killed' | 'disposed' | false>;
    onData(cb: (ev: { id: string; data: string }) => void): () => void;
    onExit(cb: (ev: { id: string; code: number | null; signal: string | null }) => void): () => void;
  };
  clip: {
    read(): Promise<{ text: string }>;
    write(text: string): Promise<{ ok: boolean }>;
  };
  git(op: string, args?: Record<string, unknown>): Promise<any>;
  api: {
    send(req: { reqId: string; method: string; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{
      ok: boolean; status: number; statusText: string; url: string; ms: number; size: number;
      truncated: boolean; headers: Record<string, string>; body: string;
    }>;
    cancel(reqId: string): Promise<boolean>;
  };
  events: {
    subscribe(cb: (data: string) => void): () => void;
    onConn(cb: (connected: boolean) => void): () => void;
  };
  app: {
    state(): Promise<{
      root: string;
      recent: string[];
      restore: boolean;
      opencode: { running: boolean; version?: string; cli?: string; port?: number };
      versions: { app: string; electron: string };
    }>;
    openFolder(): Promise<{ root: string }>;
    openPath(path: string): Promise<{ root: string }>;
    setRestore(restore: boolean): Promise<{ restore: boolean }>;
    checkUpdates(): Promise<{ update: boolean; current: string; version?: string; url?: string; error?: string }>;
    pickFiles(): Promise<{ files: Array<{ path: string; name: string; size: number }> }>;
    saveDialog(defaultPath?: string): Promise<{ path: string }>;
    openExternal(url: string): Promise<{ ok: boolean }>;
    retryOpencode(): Promise<{ root: string }>;
    notify(n: { title: string; body?: string; kind?: string; badge?: boolean }): Promise<{ ok: boolean; count: number }>;
    clearAttention(): Promise<{ ok: boolean }>;
    pickSound(): Promise<{ ok: boolean; id: string; name: string; fileUrl: string }>;
    onMenu(cb: (kind: 'toggle-agent' | 'palette' | 'new-session' | 'root-changed' | 'opencode:ready' | 'opencode:error', payload?: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    barang?: BarangBridge;
  }
}

export function barang(): BarangBridge {
  const b = window.barang;
  if (!b) {
    throw new Error(
      'Barang desktop bridge is missing. Open Barang from the desktop app (npm start / dist exe), not a browser tab.',
    );
  }
  return b;
}
