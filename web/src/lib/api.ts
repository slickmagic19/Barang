// Renderer client for the desktop backend (Electron main via preload).
// Same route shapes as before — only the transport changed (IPC, no HTTP).
import { barang } from './transport';

export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FsEntry[];
}

export const fsApi = {
  tree: (path = '.', depth = 1, all = false) => barang().fs.tree(path, depth, all),
  read: (path: string) => barang().fs.read(path),
  write: (path: string, content: string) => barang().fs.write(path, content),
  mkdir: (path: string) => barang().fs.mkdir(path),
  rename: (from: string, to: string) => barang().fs.rename(from, to),
  remove: (path: string) => barang().fs.remove(path),
  readExternal: (path: string) => barang().fs.readExternal(path),
  writeAbsolute: (path: string, content: string) => barang().fs.writeAbsolute(path, content),
  find: (query: string, limit = 50) => barang().fs.find(query, limit),
  search: (q: string, path = '', limit = 50) => barang().fs.search(q, path, limit),
  searchReplace: (args: { q: string; replacement?: string; regex?: boolean; caseSensitive?: boolean; path?: string; dryRun?: boolean }) =>
    barang().fs.searchReplace(args),
};

/** Direct opencode calls through main (auth injected there). Paths like '/session'. */
export const oc = {
  get: <T>(path: string) => barang().oc(path) as Promise<T>,
  post: <T>(path: string, body?: unknown) =>
    barang().oc(path, { method: 'POST', body }) as Promise<T>,
  put: <T>(path: string, body?: unknown) =>
    barang().oc(path, { method: 'PUT', body }) as Promise<T>,
  patch: <T>(path: string, body?: unknown) =>
    barang().oc(path, { method: 'PATCH', body }) as Promise<T>,
  del: <T>(path: string) => barang().oc(path, { method: 'DELETE' }) as Promise<T>,
};

export const appState = () => barang().app.state();
