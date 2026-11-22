// Memory backend: persists Qoder-style memory files under two scopes and
// maintains the MEMORY.md index. Pure parsing/rendering lives in
// web/src/lib/memory.ts (single parser, contract-tested); main only does
// filesystem I/O.
//
// Layout (userData = app's userData dir, root = open project or ''):
//   user    — <userData>/memory/MEMORY.md + <slug>.md      (all projects)
//   project — <root>/.barang/memory/MEMORY.md + <slug>.md  (this project)
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MEMORY_DIR = 'memory';
export const MEMORY_INDEX = 'MEMORY.md';

function scopeDir(scope, { userDataDir, root }) {
  if (scope === 'user') return path.join(userDataDir, MEMORY_DIR);
  return root ? path.join(root, '.barang', MEMORY_DIR) : '';
}

function memoryFile(dir, slug) {
  return path.join(dir, `${slug}.md`);
}

/** List every memory file (slug + path + mtime) under one scope. */
async function listScope(scope, ctx) {
  const dir = scopeDir(scope, ctx);
  if (!dir) return { dir: '', entries: [] };
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, entries: [] };
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    if (d.name === MEMORY_INDEX) continue;
    const slug = d.name.slice(0, -3);
    const file = path.join(dir, d.name);
    const st = await fs.stat(file).catch(() => null);
    if (!st) continue;
    entries.push({ scope, slug, file, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  return { dir, entries };
}

/** Discover every memory across both scopes. Returns the raw records
 *  ({ scope, slug, path, mtime }) — the renderer reads + parses bytes. */
export async function discoverMemories({ userDataDir, root }) {
  const [user, project] = await Promise.all([
    listScope('user', { userDataDir, root }),
    listScope('project', { userDataDir, root }),
  ]);
  return { user: user.entries, project: project.entries };
}

/** Read one memory file's text (or null when missing). */
export async function readMemoryFile(file) {
  return fs.readFile(file, 'utf8').catch(() => null);
}

/** Read the MEMORY.md index text for a scope (or ''). */
export async function readMemoryIndex(scope, ctx) {
  const dir = scopeDir(scope, ctx);
  if (!dir) return { path: '', text: '' };
  const file = path.join(dir, MEMORY_INDEX);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return { path: file, text };
}

/** Persist a memory file + upsert its index line. `entry` is the full
 *  serialized text (renderer builds it via serializeMemory). Returns the
 *  file path. */
export async function writeMemory(scope, ctx, slug, text) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug || ''))) {
    throw new Error('Bad memory slug');
  }
  const dir = scopeDir(scope, ctx);
  if (!dir) throw new Error(scope === 'project' ? 'No folder open' : 'No user memory dir');
  await fs.mkdir(dir, { recursive: true });
  const file = memoryFile(dir, slug);
  const prev = await fs.readFile(file, 'utf8').catch(() => null);
  if (prev !== null && prev !== text) {
    await fs.writeFile(file + '.bak', prev).catch(() => {});
  }
  await fs.writeFile(file, String(text ?? ''), 'utf8');
  return file;
}

/** Append/update a line in the scope's MEMORY.md index. */
export async function writeMemoryIndex(scope, ctx, indexText) {
  const dir = scopeDir(scope, ctx);
  if (!dir) return '';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MEMORY_INDEX), String(indexText ?? ''), 'utf8');
  return path.join(dir, MEMORY_INDEX);
}

/** Delete a memory file + its index line. No-op when missing. */
export async function removeMemory(scope, ctx, slug) {
  const dir = scopeDir(scope, ctx);
  if (!dir) return false;
  const file = memoryFile(dir, slug);
  const st = await fs.stat(file).catch(() => null);
  if (!st) return false;
  await fs.rm(file, { force: true });
  return true;
}