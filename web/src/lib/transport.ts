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
    pickFiles(): Promise<{ files: Array<{ path: string; name: string; size: number }> }>;
    onMenu(cb: (kind: 'toggle-agent' | 'palette' | 'new-session' | 'root-changed', payload?: unknown) => void): () => void;
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
