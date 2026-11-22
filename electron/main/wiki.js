// Repo wiki store: one manifest + markdown pages under <root>/.barang/wiki.
// The renderer owns planning/generation; main only does filesystem I/O with
// strict validation (slugs are filenames, the manifest is model-independent).
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const WIKI_DIR = '.barang/wiki';
const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 200_000;
const MAX_PAGES = 40;

function wikiDir(root) {
  if (!root) throw new Error('No folder open');
  return path.join(root, '.barang', 'wiki');
}

function pagesDir(root) {
  return path.join(wikiDir(root), 'pages');
}

function manifestFile(root) {
  return path.join(wikiDir(root), 'wiki.json');
}

async function writeAtomic(file, text) {
  const tmp = `${file}.barang-tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** Read the manifest only (cheap check for staleness / augmentation). */
export async function readManifest(root) {
  if (!root) return null;
  try {
    const text = await fs.readFile(manifestFile(root), 'utf8');
    if (text.length > MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the manifest plus every listed page body. Missing pages are skipped. */
export async function readWiki(root) {
  const manifest = await readManifest(root);
  if (!manifest || !Array.isArray(manifest.pages)) return { manifest: null, pages: {} };
  const pages = {};
  for (const meta of manifest.pages.slice(0, MAX_PAGES)) {
    const slug = String(meta?.slug ?? '');
    if (!PAGE_SLUG_RE.test(slug)) continue;
    try {
      const text = await fs.readFile(path.join(pagesDir(root), `${slug}.md`), 'utf8');
      if (text.length <= MAX_PAGE_CHARS) pages[slug] = text;
    } catch {
      // Page file missing — the manifest is ahead of disk; renderer heals it.
    }
  }
  return { manifest, pages };
}

/** Write generated pages + the manifest, then prune pages no longer listed. */
export async function writeWiki(root, manifest, pages) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Bad wiki manifest');
  }
  const dir = wikiDir(root);
  const pdir = pagesDir(root);
  await fs.mkdir(pdir, { recursive: true });

  for (const [slug, text] of Object.entries(pages && typeof pages === 'object' ? pages : {}).slice(0, MAX_PAGES)) {
    if (!PAGE_SLUG_RE.test(slug)) continue;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_PAGE_CHARS) continue;
    await writeAtomic(path.join(pdir, `${slug}.md`), text);
  }

  const keep = new Set(
    (Array.isArray(manifest.pages) ? manifest.pages : [])
      .map((p) => String(p?.slug ?? ''))
      .filter((s) => PAGE_SLUG_RE.test(s)),
  );
  let dirents = [];
  try {
    dirents = await fs.readdir(pdir, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    if (!keep.has(d.name.slice(0, -3))) await fs.rm(path.join(pdir, d.name), { force: true });
  }

  const text = JSON.stringify(manifest);
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('Wiki manifest too large');
  await writeAtomic(manifestFile(root), text);
  return { ok: true, pages: keep.size };
}

/** Remove the wiki directory (manual reset). */
export async function clearWiki(root) {
  if (!root) throw new Error('No folder open');
  await fs.rm(wikiDir(root), { recursive: true, force: true });
  return { ok: true };
}
