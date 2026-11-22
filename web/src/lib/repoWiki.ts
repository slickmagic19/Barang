// Qoder-style Repo Wiki.
//
// Generated markdown pages describe the open project: an overview, the
// architecture, the tech stack, conventions, and one page per module. The
// plan is deterministic (derived from the cached repo index), only the page
// bodies come from a model. Pages live in <root>/.barang/wiki so they survive
// restarts and are browsable in-app; generation runs in hidden sessions, so
// the user's transcript is never polluted.
//
// Updates are incremental: a manifest of file stamps tells us what changed,
// pages are re-generated only when their sources changed (or are missing /
// the wiki is incomplete), and auto runs are capped so a big repo costs a few
// calls per pass instead of dozens at once.
import { oc } from './api';
import { barang } from './transport';
import { createStore } from './util';
import {
  extOf,
  importScores,
  languageSummary,
  type IndexedFile,
  type RepoIndex,
} from './repoIndex';

export const WIKI_VERSION = 1;
export const WIKI_DIR = '.barang/wiki';
export const WIKI_SESSION_TITLE = '__barang_wiki_gen__';
export const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_MODULES = 6;
export const MAX_WIKI_PAGES = 40;
export const AUTO_PAGES_PER_RUN = 4;
export const MAX_PAGE_CHARS = 24_000;
export const WIKI_STALE_MS = 24 * 60 * 60 * 1000;
export const AUTO_SYNC_MIN_INTERVAL_MS = 90_000;
export const WIKI_MODEL_TIMEOUT_MS = 120_000;

export type WikiPageKind = 'overview' | 'architecture' | 'tech-stack' | 'conventions' | 'module';
export type WikiModuleRelation = { type: 'imports' | 'imported-by'; to: string };

export interface WikiPageMeta {
  slug: string;
  title: string;
  kind: WikiPageKind;
  summary: string;
  sources: string[];
}

export interface WikiModuleMeta {
  id: string;
  name: string;
  paths: string[];
  relations: WikiModuleRelation[];
}

export interface WikiManifest {
  version: number;
  generatedAt: number;
  model: string;
  fingerprint: string;
  files: Record<string, number>;
  pages: WikiPageMeta[];
  modules: WikiModuleMeta[];
  complete: boolean;
}

export interface WikiPageSpec extends WikiPageMeta {
  regenerate: boolean;
}

export interface WikiGenerationPlan {
  reason: string;
  targets: WikiPageSpec[]; // pages to write this run (capped)
  allPages: WikiPageMeta[]; // full desired page list
  removed: string[]; // slugs pruned from the manifest
  pending: number; // stale pages left for a later run
  baseManifest: WikiManifest;
  fresh: boolean;
  modules: WikiModuleMeta[];
  fileCount: number;
  languageSummary: string;
  truncated: boolean;
  fingerprint: string;
}

export interface WikiBuildResult {
  manifest: WikiManifest;
  generated: string[];
  failed: string[];
  pending: number;
  written: boolean;
}

export interface WikiProgress {
  slug: string;
  title: string;
  done: number;
  total: number;
  ok: boolean;
}

export interface WikiState {
  status: 'idle' | 'planning' | 'generating' | 'done' | 'error';
  message: string;
  done: number;
  total: number;
  manifest: WikiManifest | null;
  error: string | null;
}

export const wikiStore = createStore<WikiState>({
  status: 'idle',
  message: '',
  done: 0,
  total: 0,
  manifest: null,
  error: null,
});

// ---------------------------------------------------------------------------
// File stamps + fingerprints
// ---------------------------------------------------------------------------

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable content-ish fingerprint over indexed files. Pure. */
export function wikiFingerprint(files: IndexedFile[]): string {
  const parts = (files ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}\0${f.size}\0${f.mtime ?? 0}\0${f.symbols.join(',')}`);
  return fnv1a(parts.join('\n'));
}

/** Per-file stamps persisted in the manifest. mtime when known; a negative
 *  size otherwise, so a size change still registers. Pure. */
export function fileStamps(files: IndexedFile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files ?? []) {
    out[f.path] = f.mtime && f.mtime > 0 ? f.mtime : -Math.max(0, f.size);
  }
  return out;
}

export interface FileDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** Compare the persisted stamps with the current index. Pure. */
export function diffFiles(
  prev: Record<string, number> | null | undefined,
  files: IndexedFile[],
): FileDiff {
  const now = fileStamps(files);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, stamp] of Object.entries(now)) {
    if (!prev || !(path in prev)) added.push(path);
    else if (prev[path] !== stamp) changed.push(path);
  }
  if (prev) {
    for (const path of Object.keys(prev)) if (!(path in now)) removed.push(path);
  }
  added.sort();
  changed.sort();
  removed.sort();
  return { added, changed, removed };
}

// ---------------------------------------------------------------------------
// Module derivation (deterministic, no model)
// ---------------------------------------------------------------------------

const TEST_SEGMENT = /(^|\/)(__tests__|tests?|specs?|__mocks__|__snapshots__|e2e)(\/|$)/i;
const TEST_FILE = /\.(test|spec)\.[^/]+$/i;
const RESOLVE_EXT =
  /\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|h|cc|cpp|hpp|rb|php|swift|scala|vue|svelte|astro|css|scss|less|html)$/i;

/** Test/spec files document behavior, not module structure. Pure. */
export function isTestPath(path: string): boolean {
  const p = String(path ?? '');
  return TEST_SEGMENT.test(p) || TEST_FILE.test(p);
}

function parentDir(path: string): string {
  const i = String(path ?? '').lastIndexOf('/');
  return i > 0 ? String(path).slice(0, i) : '';
}

function kebabId(value: string, max = 40): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

function prettyLabel(segment: string): string {
  if (!segment) return 'Root';
  return segment
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Page slug for a module id. Pure. */
export function modulePageSlug(id: string): string {
  const safe = kebabId(id, 56);
  return `module-${safe || 'root'}`;
}

function resolveRelative(dir: string, spec: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${spec}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export interface ModuleOptions {
  maxModules?: number;
  scores?: Map<string, number>;
}

/** Group source files into a handful of modules by directory, merging small
 *  groups upward until the cap is met. Test files are ignored. Pure. */
export function deriveModules(files: IndexedFile[], opts: ModuleOptions = {}): WikiModuleMeta[] {
  const maxModules = Math.max(1, opts.maxModules ?? MAX_MODULES);
  const scores = opts.scores ?? importScores(files ?? []);
  const groups = new Map<string, IndexedFile[]>();
  for (const f of files ?? []) {
    if (isTestPath(f.path)) continue;
    const dir = parentDir(f.path);
    const list = groups.get(dir);
    if (list) list.push(f);
    else groups.set(dir, [f]);
  }
  if (!groups.size) return [];

  const sizeOf = (dir: string) => groups.get(dir)?.length ?? 0;
  const weightOf = (dir: string) =>
    (groups.get(dir) ?? []).reduce((n, f) => n + 1 + (scores.get(f.path) ?? 0), 0);
  const order = (a: string, b: string) =>
    sizeOf(a) - sizeOf(b) || weightOf(a) - weightOf(b) || a.localeCompare(b);

  let guard = 0;
  while (groups.size > maxModules && guard++ < 200) {
    const dirs = [...groups.keys()].sort(order);
    const small = dirs[0];
    const moved = groups.get(small);
    if (!moved) break;
    if (!small) {
      // Loose top-level files: fold them into the largest group instead of
      // leaving the root group stranded as the smallest.
      const biggest = dirs[dirs.length - 1];
      if (biggest === small) break;
      groups.delete(small);
      groups.get(biggest)?.push(...moved);
      continue;
    }
    const parent = parentDir(small);
    groups.delete(small);
    const into = groups.get(parent);
    if (into) into.push(...moved);
    else groups.set(parent, moved);
  }

  const fileToModule = new Map<string, string>();
  for (const [dir, list] of groups) for (const f of list) fileToModule.set(f.path, dir);

  const byNoExt = new Map<string, string>();
  for (const [dir, list] of groups) {
    for (const f of list) {
      const noExt = f.path.replace(RESOLVE_EXT, '');
      if (!byNoExt.has(noExt)) byNoExt.set(noExt, f.path);
    }
  }

  const byDir = [...groups.entries()].sort((a, b) => {
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  const usedIds = new Set<string>();
  const modules: WikiModuleMeta[] = [];
  for (const [dir, list] of byDir) {
    const paths = list
      .slice()
      .sort(
        (a, b) =>
          (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || a.path.localeCompare(b.path),
      )
      .map((f) => f.path);
    let id = kebabId(dir) || 'root';
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const relations: WikiModuleRelation[] = [];
    for (const f of list) {
      const importerDir = parentDir(f.path);
      for (const spec of f.imports) {
        if (!/^\.{0,2}\//.test(spec)) continue;
        const resolved = resolveRelative(importerDir, spec).replace(RESOLVE_EXT, '');
        const targetPath =
          byNoExt.get(resolved) ?? byNoExt.get(`${resolved}/index`) ?? undefined;
        if (!targetPath) continue;
        const targetDir = fileToModule.get(targetPath);
        if (!targetDir || targetDir === dir) continue;
        const to = kebabId(targetDir) || 'root';
        if (!relations.some((r) => r.to === to)) relations.push({ type: 'imports', to });
        if (relations.length >= 6) break;
      }
      if (relations.length >= 6) break;
    }

    modules.push({
      id,
      name: prettyLabel(dir.split('/').filter(Boolean).pop() ?? ''),
      paths,
      relations,
    });
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Page plan (deterministic)
// ---------------------------------------------------------------------------

const KIND_PRIORITY: Record<WikiPageKind, number> = {
  overview: 0,
  architecture: 1,
  module: 2,
  'tech-stack': 3,
  conventions: 4,
};

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function uniqueStrings(list: string[], max: number): string[] {
  const out: string[] = [];
  for (const item of list) {
    const v = String(item ?? '');
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** The full desired page list for an index: fixed pages + one per module. */
export function computePageMetas(
  index: RepoIndex,
  modules: WikiModuleMeta[],
  scores?: Map<string, number>,
): WikiPageMeta[] {
  const files = index?.files ?? [];
  const centrality = scores ?? importScores(files);
  const ranked = files
    .filter((f) => !isTestPath(f.path))
    .slice()
    .sort(
      (a, b) =>
        (centrality.get(b.path) ?? 0) - (centrality.get(a.path) ?? 0) ||
        a.path.localeCompare(b.path),
    );
  const top = (n: number) => ranked.slice(0, n).map((f) => f.path);

  const pages: WikiPageMeta[] = [
    {
      slug: 'overview',
      title: 'Project Overview',
      kind: 'overview',
      summary: '',
      sources: top(4),
    },
    {
      slug: 'architecture',
      title: 'Architecture',
      kind: 'architecture',
      summary: '',
      sources: uniqueStrings(
        [...modules.map((m) => m.paths[0]).filter(Boolean), ...top(2)],
        8,
      ),
    },
  ];

  for (const m of modules) {
    pages.push({
      slug: modulePageSlug(m.id),
      title: `${m.name} module`,
      kind: 'module',
      summary: '',
      sources: m.paths.slice(0, 6),
    });
  }

  const byExt = new Map<string, string>();
  for (const f of ranked) {
    const ext = extOf(f.path);
    if (ext && !byExt.has(ext)) byExt.set(ext, f.path);
    if (byExt.size >= 6) break;
  }
  pages.push({
    slug: 'tech-stack',
    title: 'Tech Stack',
    kind: 'tech-stack',
    summary: '',
    sources: [...byExt.values()],
  });
  pages.push({
    slug: 'conventions',
    title: 'Conventions',
    kind: 'conventions',
    summary: '',
    sources: top(3),
  });
  return pages;
}

export interface PlanOptions {
  manifest: WikiManifest | null;
  index: RepoIndex;
  now?: number;
  force?: boolean;
  maxPages?: number;
  staleMs?: number;
  /** Slugs whose page body exists on disk (catches hand-deleted pages). */
  existingBodies?: Iterable<string>;
}

/** Decide what to (re)generate. Pure given its inputs. */
export function planGeneration(opts: PlanOptions): WikiGenerationPlan {
  const now = opts.now ?? Date.now();
  const maxPages = Math.max(1, opts.maxPages ?? AUTO_PAGES_PER_RUN);
  const staleMs = opts.staleMs ?? WIKI_STALE_MS;
  const manifest = opts.manifest && opts.manifest.version === WIKI_VERSION ? opts.manifest : null;
  const scores = importScores(opts.index?.files ?? []);
  const modules = deriveModules(opts.index?.files ?? [], { scores });
  const desired = computePageMetas(opts.index, modules, scores);
  const files = fileStamps(opts.index?.files ?? []);
  const fingerprint = wikiFingerprint(opts.index?.files ?? []);
  const bodies = new Set(opts.existingBodies ?? []);

  const basePages: WikiPageMeta[] = desired.map((p) => {
    const old = manifest?.pages.find((x) => x.slug === p.slug);
    return { ...p, summary: old?.summary ?? '' };
  });
  const baseManifest: WikiManifest = {
    version: WIKI_VERSION,
    generatedAt: manifest?.generatedAt ?? 0,
    model: manifest?.model ?? '',
    fingerprint,
    files,
    pages: basePages,
    modules,
    complete: false,
  };
  const identity = {
    modules,
    fileCount: opts.index?.files?.length ?? 0,
    languageSummary: languageSummary(opts.index?.files ?? []),
    truncated: !!opts.index?.truncated,
    fingerprint,
  };

  if (!(opts.index?.files?.length ?? 0) || !(opts.index?.files ?? []).some((f) => !isTestPath(f.path))) {
    return {
      reason: 'No indexable source files',
      targets: [],
      allPages: [],
      removed: [],
      pending: 0,
      baseManifest: manifest ?? baseManifest,
      fresh: true,
      ...identity,
    };
  }

  const wanted = new Set(basePages.map((p) => p.slug));
  const removed = (manifest?.pages ?? []).map((p) => p.slug).filter((s) => !wanted.has(s));
  const diff = diffFiles(manifest?.files ?? null, opts.index.files);
  const touched = new Set([...diff.added, ...diff.changed, ...diff.removed]);
  const aged = !!manifest && !manifest.complete && now - manifest.generatedAt > staleMs;
  const oldModules = (manifest?.modules ?? []).map((m) => m.id).sort().join(',');
  const newModules = modules.map((m) => m.id).sort().join(',');
  // Overview/architecture describe the module layout — refresh them when that
  // layout (or the page set itself) changed, even if their cited files did not.
  const structureChanged = !!manifest && (removed.length > 0 || oldModules !== newModules);

  const stale: WikiPageSpec[] = [];
  for (const page of basePages) {
    const old = manifest?.pages.find((x) => x.slug === page.slug);
    const sameSources = old ? sameSet(old.sources, page.sources) : false;
    const sourceTouched = old ? old.sources.some((s) => touched.has(s)) : false;
    const missingBody = !bodies.has(page.slug);
    const structural = structureChanged && (page.kind === 'overview' || page.kind === 'architecture');
    const regenerate =
      !!opts.force ||
      !old ||
      !manifest?.complete ||
      !sameSources ||
      sourceTouched ||
      structural ||
      missingBody ||
      aged;
    if (regenerate) stale.push({ ...page, regenerate: true });
  }
  stale.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);

  const targets = stale.slice(0, maxPages);
  const pending = stale.length - targets.length;
  const changeCount = diff.added.length + diff.changed.length + diff.removed.length;
  const reasons: string[] = [];
  if (opts.force) reasons.push('Manual rebuild');
  else if (!manifest) reasons.push('Initial build');
  else if (!manifest.complete) reasons.push('Completing wiki');
  else if (changeCount) reasons.push(`${changeCount} file${changeCount === 1 ? '' : 's'} changed`);
  if (diff.added.length && manifest) reasons.push(`${diff.added.length} added`);
  if (diff.removed.length && manifest) reasons.push(`${diff.removed.length} removed`);
  if (removed.length) reasons.push(`${removed.length} page${removed.length === 1 ? '' : 's'} removed`);

  return {
    reason: reasons.join(' · ') || 'Up to date',
    targets,
    allPages: basePages,
    removed,
    pending,
    baseManifest,
    fresh: targets.length === 0 && removed.length === 0,
    ...identity,
  };
}

// ---------------------------------------------------------------------------
// Prompt + output cleanup
// ---------------------------------------------------------------------------

const KIND_GUIDE: Record<WikiPageKind, string> = {
  overview:
    'Explain what the project is, who it serves, its main capabilities, and how the pieces fit together. Mention how to run it only when the files make that obvious.',
  architecture:
    'Explain the layering, entry points, data flow, and how modules collaborate. Use the module list above and call out the most central modules.',
  'tech-stack':
    'List the languages, frameworks, libraries, and tools visibly used, grouped by area. Do not speculate about tooling that is not visible in the files.',
  conventions:
    'Describe naming, file layout, error handling, state management, and other patterns the code consistently uses. Base every claim on the excerpts.',
  module:
    "Explain this module's purpose, key exports, internal structure, and which other modules it talks to.",
};

export interface PagePromptInput {
  page: WikiPageMeta;
  fileCount: number;
  languageSummary?: string;
  truncated?: boolean;
  modules: WikiModuleMeta[];
  related?: WikiPageMeta[];
  excerpts: Array<{ path: string; text: string }>;
}

/** Prompt for one page. Pure. */
export function buildPagePrompt(input: PagePromptInput): string {
  const page = input.page;
  const lines: string[] = [
    'You are writing one page of a repository wiki for a software project open in the Barang editor.',
    '',
    '## Page to write',
    `- Title: ${page.title}`,
    `- Kind: ${page.kind}`,
    `- File path: ${WIKI_DIR}/pages/${page.slug}.md`,
  ];
  const others = (input.related ?? []).filter((p) => p.slug !== page.slug).slice(0, 10);
  if (others.length) lines.push(`- Other wiki pages: ${others.map((p) => p.title).join(', ')}`);

  lines.push(
    '',
    '## Repository',
    `${input.fileCount} indexed source files${input.languageSummary ?? ''}${input.truncated ? ' (scan truncated)' : ''}.`,
  );
  if (input.modules.length) {
    lines.push('', '## Modules');
    for (const m of input.modules) {
      const shown = m.paths.slice(0, 3).join(', ');
      const paths = m.paths.length > 3 ? `${shown}, … (${m.paths.length} files)` : shown;
      const rel = m.relations.length
        ? ` — imports: ${m.relations.map((r) => r.to).join(', ')}`
        : '';
      lines.push(`- ${m.name}: ${paths}${rel}`);
    }
  }

  lines.push('', '## Source excerpts');
  if (!input.excerpts.length) {
    lines.push('(No files could be read for this page. Stay high level and do not invent details.)');
  }
  for (const ex of input.excerpts) {
    const fence = ex.text.includes('```') ? '````' : '```';
    lines.push(`### ${ex.path}`, fence, ex.text, fence);
  }

  lines.push(
    '',
    '## Rules',
    `1. ${KIND_GUIDE[page.kind]}`,
    '2. Output ONLY one markdown page. Start with a single "# " heading. No preamble, no frontmatter, no outer code fence.',
    '3. Put file paths and symbol names in `backticks`. Never invent files, APIs, or tools that are not visible above.',
    '4. 150-400 words. Short paragraphs and bullet lists are welcome.',
    '5. Write for a new contributor who has never seen this codebase. Be concrete, not generic.',
  );
  return lines.join('\n');
}

/** First prose line of a page, for the wiki index / nav. Pure. */
export function summarizePage(markdown: string, fallback = ''): string {
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('```')) continue;
    const plain = t
      .replace(/^[-*+]\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length >= 20) return plain.slice(0, 200);
  }
  return fallback;
}

/** Clean a model reply into a usable page. Rejects empty/out-of-shape output
 *  (returns ''), so a bad call never overwrites a good page. Pure. */
export function sanitizePageMarkdown(
  raw: string,
  page: { title: string },
  maxChars = MAX_PAGE_CHARS,
): string {
  let t = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!t) return '';
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const wholeFence = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(t);
  if (wholeFence) t = wholeFence[2].trim();
  const heading = /^#\s+/m.exec(t);
  if (heading && heading.index > 0) t = t.slice(heading.index);
  if (!/^#\s+/m.test(t)) t = `# ${page.title}\n\n${t}`;
  t = t.replace(/\n{4,}/g, '\n\n\n').trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}…`;
  const visible = t.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
  return visible.length >= 20 ? t : '';
}

// ---------------------------------------------------------------------------
// Manifest parsing + wiki index block
// ---------------------------------------------------------------------------

const PAGE_KINDS: WikiPageKind[] = ['overview', 'architecture', 'tech-stack', 'conventions', 'module'];

/** Validate a manifest read from disk. Returns null when unusable. Pure. */
export function parseWikiManifest(raw: unknown): WikiManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const pages: WikiPageMeta[] = [];
  for (const item of Array.isArray(r.pages) ? r.pages : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const slug = String(p.slug ?? '');
    if (!PAGE_SLUG_RE.test(slug) || pages.some((x) => x.slug === slug)) continue;
    const kind = PAGE_KINDS.includes(String(p.kind) as WikiPageKind)
      ? (String(p.kind) as WikiPageKind)
      : 'module';
    const sources = Array.isArray(p.sources)
      ? p.sources.filter((s): s is string => typeof s === 'string' && !!s).slice(0, 40)
      : [];
    const title = String(p.title ?? '').trim().slice(0, 120) || slug;
    pages.push({ slug, title, kind, summary: String(p.summary ?? '').slice(0, 240), sources });
    if (pages.length >= MAX_WIKI_PAGES) break;
  }

  const modules: WikiModuleMeta[] = [];
  for (const item of Array.isArray(r.modules) ? r.modules : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    const id = kebabId(String(m.id ?? ''));
    if (!id) continue;
    const paths = Array.isArray(m.paths)
      ? m.paths.filter((p): p is string => typeof p === 'string' && !!p).slice(0, 80)
      : [];
    const relations: WikiModuleRelation[] = [];
    for (const rel of Array.isArray(m.relations) ? m.relations : []) {
      if (!rel || typeof rel !== 'object') continue;
      const rr = rel as Record<string, unknown>;
      const to = kebabId(String(rr.to ?? ''));
      if (to && !relations.some((x) => x.to === to)) relations.push({ type: 'imports', to });
      if (relations.length >= 8) break;
    }
    modules.push({
      id,
      name: String(m.name ?? '').trim().slice(0, 80) || prettyLabel(id),
      paths,
      relations,
    });
    if (modules.length >= MAX_MODULES * 2) break;
  }

  const files: Record<string, number> = {};
  if (r.files && typeof r.files === 'object' && !Array.isArray(r.files)) {
    for (const [path, stamp] of Object.entries(r.files as Record<string, unknown>)) {
      if (typeof stamp === 'number' && Number.isFinite(stamp)) files[path] = stamp;
    }
  }

  return {
    version: Number.isFinite(r.version) ? Number(r.version) : WIKI_VERSION,
    generatedAt: Number.isFinite(r.generatedAt) ? Number(r.generatedAt) : 0,
    model: typeof r.model === 'string' ? r.model.slice(0, 120) : '',
    fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : '',
    files,
    pages,
    modules,
    complete: r.complete === true,
  };
}

export interface WikiIndexOptions {
  maxPages?: number;
  maxChars?: number;
}

/** Compact wiki index injected into a turn — titles + summaries + paths, not
 *  page bodies (the agent reads the page it needs). Pure. */
export function buildWikiIndexBlock(
  manifest: WikiManifest | null | undefined,
  opts: WikiIndexOptions = {},
): string {
  const pages = (manifest?.pages ?? []).filter((p) => p.title);
  if (!pages.length) return '';
  const maxPages = Math.max(1, opts.maxPages ?? 12);
  const maxChars = Math.max(200, opts.maxChars ?? 2000);
  const header = [
    '## Repo wiki',
    `Generated documentation for this project${manifest?.complete ? '' : ' (still being generated)'}. ` +
      `Pages live in \`${WIKI_DIR}/pages/\`; read the one that helps instead of exploring blindly.`,
  ].join('\n');
  const lines: string[] = [];
  let used = header.length + 1;
  for (const page of pages.slice(0, maxPages)) {
    const summary = page.summary ? ` — ${page.summary}` : '';
    const line = `- ${page.title} (\`${WIKI_DIR}/pages/${page.slug}.md\`)${summary}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Build (model calls + writes)
// ---------------------------------------------------------------------------

export type WikiModelSelector = { providerID: string; modelID: string } | null;

export interface WikiBuildDeps {
  model?: WikiModelSelector;
  readFile?: (rel: string) => Promise<string>;
  callModel?: (prompt: string) => Promise<string>;
  write?: boolean; // default true
  existingPages?: Record<string, string>;
  onProgress?: (ev: WikiProgress) => void;
  now?: () => number;
}

async function defaultReadFile(rel: string): Promise<string> {
  const r = await barang().fs.read(rel);
  return r?.content && !r.binary ? String(r.content) : '';
}

/** Read the files a page cites, capped per file and in total. Never throws. */
export async function collectExcerpts(
  sources: string[],
  readFile: (rel: string) => Promise<string>,
  opts: { perFile?: number; total?: number; maxFiles?: number } = {},
): Promise<Array<{ path: string; text: string }>> {
  const perFile = opts.perFile ?? 1800;
  const total = opts.total ?? 12_000;
  const maxFiles = opts.maxFiles ?? 6;
  const out: Array<{ path: string; text: string }> = [];
  let used = 0;
  for (const path of sources ?? []) {
    if (out.length >= maxFiles || used >= total) break;
    let raw = '';
    try {
      raw = String((await readFile(path)) ?? '');
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    const cap = Math.min(perFile, total - used);
    if (cap <= 0) break;
    out.push({ path, text: raw.slice(0, cap) });
    used += Math.min(raw.length, cap);
  }
  return out;
}

/** Run one plan: write page bodies, merge summaries, persist the manifest.
 *  Failed pages are kept as-is and retried on a later run. */
export async function runWikiBuild(
  plan: WikiGenerationPlan,
  deps: WikiBuildDeps = {},
): Promise<WikiBuildResult> {
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? defaultReadFile;
  const callModel =
    deps.callModel ?? ((prompt: string) => callWikiModel(prompt, deps.model ?? null));
  const existing = deps.existingPages ?? {};
  const generated: string[] = [];
  const failed: string[] = [];
  const bodies: Record<string, string> = {};
  const total = plan.targets.length;

  for (let i = 0; i < total; i++) {
    const target = plan.targets[i];
    let body = '';
    try {
      const excerpts = await collectExcerpts(target.sources, readFile);
      const prompt = buildPagePrompt({
        page: target,
        fileCount: plan.fileCount,
        languageSummary: plan.languageSummary,
        truncated: plan.truncated,
        modules: plan.modules,
        related: plan.baseManifest.pages,
        excerpts,
      });
      body = sanitizePageMarkdown(await callModel(prompt), target);
    } catch {
      body = '';
    }
    if (body) {
      bodies[target.slug] = body;
      generated.push(target.slug);
    } else {
      failed.push(target.slug);
    }
    deps.onProgress?.({ slug: target.slug, title: target.title, done: i + 1, total, ok: !!body });
  }

  const pages = plan.baseManifest.pages.map((page) => {
    const body = bodies[page.slug] ?? existing[page.slug] ?? '';
    return body ? { ...page, summary: summarizePage(body, page.summary) || page.summary } : page;
  });
  const haveAll = pages.every((p) => (bodies[p.slug] ?? existing[p.slug] ?? '').trim());
  const manifest: WikiManifest = {
    ...plan.baseManifest,
    generatedAt: now(),
    model: deps.model
      ? `${deps.model.providerID}/${deps.model.modelID}`
      : plan.baseManifest.model,
    pages,
    complete: failed.length === 0 && plan.pending === 0 && haveAll,
  };

  let written = false;
  if (deps.write !== false) {
    try {
      await barang().wiki.write(manifest, bodies);
      written = true;
    } catch {
      written = false;
    }
  }
  return {
    manifest,
    generated,
    failed,
    pending: plan.pending + failed.length,
    written,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ModelMessage {
  info?: { role?: unknown; error?: unknown };
  parts?: Array<{ type?: unknown; text?: unknown }>;
}

function lastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (String(m?.info?.role ?? '').toLowerCase() !== 'assistant') continue;
    const text = (m.parts ?? [])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
      .map((p) => String(p.text))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/** True when the latest assistant message failed (rate limit, auth, …). */
function lastAssistantFailed(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (String(m?.info?.role ?? '').toLowerCase() !== 'assistant') continue;
    return !!m.info?.error;
  }
  return false;
}

let modelRunning = false;

/** One page via a hidden session that is deleted afterwards. Never throws. */
export async function callWikiModel(
  prompt: string,
  model: WikiModelSelector,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  if (modelRunning) return '';
  modelRunning = true;
  let sessionId = '';
  try {
    try {
      const created = await oc.post<{ id?: string }>('/session', { title: WIKI_SESSION_TITLE });
      sessionId = String(created?.id ?? '');
    } catch {
      return '';
    }
    if (!sessionId) return '';
    await oc.post(`/session/${sessionId}/prompt_async`, {
      ...(model ? { model } : {}),
      parts: [{ type: 'text', text: prompt }],
    });
    const timeout = opts.timeoutMs ?? WIKI_MODEL_TIMEOUT_MS;
    const started = Date.now();
    let text = '';
    for (;;) {
      await sleep(700);
      const status = await oc
        .get<Record<string, { type?: string }>>('/session/status')
        .catch(() => undefined);
      const msgs = await oc
        .get<ModelMessage[] | { value?: ModelMessage[] }>(`/session/${sessionId}/message`)
        .catch(() => [] as ModelMessage[]);
      const list = Array.isArray(msgs) ? msgs : (msgs?.value ?? []);
      const got = lastAssistantText(list);
      if (got) text = got;
      const entry = status?.[sessionId];
      const idle = !entry || entry.type === 'idle';
      if (text && idle) break;
      if (!text && idle && lastAssistantFailed(list)) break; // auth / rate limit
      if (Date.now() - started > timeout) break;
    }
    return text;
  } catch {
    return '';
  } finally {
    modelRunning = false;
    if (sessionId) void oc.del(`/session/${sessionId}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Bridge reads + auto-sync guard
// ---------------------------------------------------------------------------

/** Manifest + page bodies from disk. Never throws. */
export async function readWiki(): Promise<{
  manifest: WikiManifest | null;
  pages: Record<string, string>;
}> {
  try {
    const r = await barang().wiki.read();
    const manifest = parseWikiManifest(r?.manifest);
    const pages: Record<string, string> = {};
    for (const [slug, text] of Object.entries(r?.pages ?? {})) {
      if (PAGE_SLUG_RE.test(slug) && typeof text === 'string' && text.trim()) {
        pages[slug] = String(text);
      }
    }
    return { manifest, pages };
  } catch {
    return { manifest: null, pages: {} };
  }
}

/** Manifest only (no page bodies). Never throws. */
export async function readWikiManifest(): Promise<WikiManifest | null> {
  try {
    return parseWikiManifest(await barang().wiki.manifest());
  } catch {
    return null;
  }
}

export interface AutoSyncState {
  enabled: boolean;
  busy: boolean;
  running: boolean;
  root: string;
  lastRunAt: number;
  now: number;
  minIntervalMs?: number;
}

/** Auto generation only runs when enabled, idle, and outside the cooldown.
 *  Pure. */
export function shouldRunAutoSync(st: AutoSyncState): boolean {
  if (!st.enabled || st.busy || st.running || !st.root) return false;
  return st.now - st.lastRunAt >= (st.minIntervalMs ?? AUTO_SYNC_MIN_INTERVAL_MS);
}
