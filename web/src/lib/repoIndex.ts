// Local structural repository index — Barang's stand-in for Qoder's codebase
// indexing. No embeddings or external service: source files are listed through
// the desktop bridge, parsed with lightweight regex extractors for exported
// symbols and imports, and summarized into a compact "repo map" that is
// injected into the agent turn (same pipeline as skills + memory).
//
// Everything here is best-effort: unreadable or huge files are skipped, and a
// failed scan degrades to an empty map instead of blocking a send.
import { barang } from './transport';

export interface IndexedFile {
  path: string; // project-relative, forward slashes
  size: number;
  symbols: string[]; // exported / top-level names (capped)
  imports: string[]; // module specifiers (capped)
  mtime?: number; // ms — lets the wiki detect edits, not just size changes
}

export interface RepoIndex {
  files: IndexedFile[];
  truncated: boolean;
  builtAt: number;
}

export const INDEX_MAX_FILES = 400;
export const REPO_MAP_MAX_CHARS = 4000;
export const REPO_MAP_MAX_FILES = 250;

const MAX_FILE_CHARS = 200_000;
const MAX_SYMBOLS = 12;
const MAX_IMPORTS = 8;
const TIME_BUDGET_MS = 5000;
const CONCURRENCY = 8;

/** Display tag per extension. Presence also marks the file as indexable. */
const LANG_LABEL: Record<string, string> = {
  ts: 'TS', mts: 'TS', cts: 'TS', tsx: 'TSX',
  js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JSX',
  py: 'Py', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', cs: 'C#',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', scala: 'Scala',
  sh: 'Sh', bash: 'Sh', lua: 'Lua',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML',
};

const CODE_EXTS = new Set([
  'ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'cs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'rb', 'php', 'swift', 'scala',
  'sh', 'bash', 'lua', 'vue', 'svelte', 'astro',
]);

const SKIP_SEGMENTS = /(^|\/)(node_modules|\.git|\.hg|\.svn|dist|build|out|\.next|release|coverage|vendor|__pycache__|\.venv|target|bin|obj)(\/|$)/i;

export function extOf(p: string): string {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True for source files worth indexing (skips builds, deps, minified, maps). */
export function isIndexablePath(p: string): boolean {
  const s = String(p ?? '');
  if (!s) return false;
  const base = s.split('/').pop() ?? '';
  if (SKIP_SEGMENTS.test(s)) return false;
  if (/\.min\.(js|css)$/i.test(base) || /\.map$/i.test(base)) return false;
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i.test(base)) return false;
  return LANG_LABEL[extOf(s)] !== undefined;
}

function pushUnique(arr: string[], value: string) {
  const v = String(value ?? '').trim();
  if (v && !arr.includes(v)) arr.push(v);
}

/** Extract exported/top-level symbols and import specifiers. Pure. */
export function parseSymbols(relPath: string, text: string): { symbols: string[]; imports: string[] } {
  const ext = extOf(relPath);
  const symbols: string[] = [];
  const imports: string[] = [];
  const t = String(text ?? '');
  if (!CODE_EXTS.has(ext)) return { symbols, imports };

  if (['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'vue', 'svelte', 'astro'].includes(ext)) {
    for (const m of t.matchAll(/^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm)) {
      pushUnique(symbols, m[1]);
    }
    for (const m of t.matchAll(/^[ \t]*export\s+(?:default\s+)?\{([^}]*)\}/gm)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
        if (/^[A-Za-z_$][\w$]*$/.test(name)) pushUnique(symbols, name);
      }
    }
    // Non-exported entry points still help navigation (scripts, webpack apps).
    if (!symbols.length) {
      for (const m of t.matchAll(/^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) pushUnique(symbols, m[1]);
    }
    for (const m of t.matchAll(/(?:^|\s)(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      pushUnique(imports, m[1]);
    }
    for (const m of t.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) pushUnique(imports, m[1]);
  } else if (ext === 'py') {
    for (const m of t.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gm)) {
      pushUnique(symbols, m[1] ?? m[2]);
    }
    for (const m of t.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      pushUnique(imports, m[1] ?? m[2]);
    }
  } else if (ext === 'go') {
    for (const m of t.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)) pushUnique(symbols, m[1]);
    for (const m of t.matchAll(/^type\s+([A-Z]\w*)/gm)) pushUnique(symbols, m[1]);
    for (const m of t.matchAll(/^import\s+(?:[\w.]+\s+)?"([\w./-]+)"/gm)) pushUnique(imports, m[1]);
    for (const block of t.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
      for (const line of block[1].split('\n')) {
        const m = /^\s*(?:[\w.]+\s+)?"([\w./-]+)"/.exec(line);
        if (m) pushUnique(imports, m[1]);
      }
    }
  } else if (ext === 'rs') {
    for (const m of t.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|const|static|mod)\s+([A-Za-z_]\w*)/gm)) {
      pushUnique(symbols, m[1]);
    }
    for (const m of t.matchAll(/^\s*use\s+([\w:]+)/gm)) pushUnique(imports, m[1]);
  } else {
    for (const m of t.matchAll(/(?:^|\s)(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|final\s+|export\s+)*(?:class|interface|struct|enum|record|def|module|func)\s+([A-Za-z_]\w*)/gm)) {
      pushUnique(symbols, m[1]);
    }
  }
  return { symbols: symbols.slice(0, MAX_SYMBOLS), imports: imports.slice(0, MAX_IMPORTS) };
}

function byDepthThenPath<T extends string | { path: string }>(a: T, b: T): number {
  const pa = typeof a === 'string' ? a : a.path;
  const pb = typeof b === 'string' ? b : b.path;
  const da = pa.split('/').length;
  const db = pb.split('/').length;
  return da - db || pa.localeCompare(pb);
}

const IMPORT_EXT = /\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|h|cc|cpp|hpp|rb|php|swift|scala|vue|svelte|astro|css|scss|less|html)$/i;

/** Resolve a relative import against the importer's directory (POSIX). */
function resolveRel(dir: string, spec: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${spec}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Internal in-degree: how often each file is imported by other indexed files.
 *  A cheap PageRank stand-in so central modules lead the map. Pure. */
export function importScores(files: IndexedFile[]): Map<string, number> {
  const byNoExt = new Map<string, string[]>();
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const noExt = f.path.replace(IMPORT_EXT, '');
    byNoExt.set(noExt, [...(byNoExt.get(noExt) ?? []), f.path]);
    const base = noExt.split('/').pop() ?? '';
    byBase.set(base, [...(byBase.get(base) ?? []), f.path]);
  }
  const scores = new Map<string, number>();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    for (const spec of f.imports) {
      if (!/^\.{0,2}\//.test(spec)) continue; // package imports, not project files
      const resolved = resolveRel(dir, spec).replace(IMPORT_EXT, '');
      const hits = byNoExt.get(resolved) ?? byNoExt.get(`${resolved}/index`) ?? byBase.get(resolved.split('/').pop() ?? '') ?? [];
      for (const target of hits) {
        if (target === f.path) continue;
        scores.set(target, (scores.get(target) ?? 0) + 1);
      }
    }
  }
  return scores;
}

export interface IndexOptions {
  maxFiles?: number;
  timeBudgetMs?: number;
  concurrency?: number;
}

/** Scan the open project and parse its source files. Never throws. */
export async function buildRepoIndex(_root: string, opts: IndexOptions = {}): Promise<RepoIndex> {
  const started = Date.now();
  const maxFiles = opts.maxFiles ?? INDEX_MAX_FILES;
  const budget = opts.timeBudgetMs ?? TIME_BUDGET_MS;
  let truncated = false;
  let paths: string[] = [];
  try {
    const listed = await barang().fs.listFiles();
    const all = (listed?.files ?? []).filter(isIndexablePath).sort(byDepthThenPath);
    if (listed?.truncated || all.length > maxFiles) truncated = true;
    paths = all.slice(0, maxFiles);
  } catch {
    return { files: [], truncated: false, builtAt: Date.now() };
  }
  const files: IndexedFile[] = [];
  let next = 0;
  const readOne = async () => {
    while (next < paths.length) {
      if (Date.now() - started > budget) {
        truncated = true;
        return;
      }
      const rel = paths[next++];
      let r: { content?: string; binary?: boolean; size?: number; mtime?: number } | undefined;
      try {
        r = await barang().fs.read(rel);
      } catch {
        continue;
      }
      if (!r?.content || r.binary || r.content.length > MAX_FILE_CHARS) continue;
      const { symbols, imports } = parseSymbols(rel, r.content);
      files.push({ path: rel, size: r.size ?? r.content.length, symbols, imports, mtime: r.mtime ?? 0 });
    }
  };
  const workers = Math.min(opts.concurrency ?? CONCURRENCY, Math.max(1, paths.length));
  await Promise.all(Array.from({ length: workers }, readOne));
  files.sort(byDepthThenPath);
  return { files, truncated, builtAt: Date.now() };
}

// One cached index per project root (shared by the repo map + repo wiki).
const indexCache = new Map<string, { at: number; index: RepoIndex }>();
export const INDEX_TTL_MS = 5 * 60_000;

/** Cached index for the open project; rebuilds after the TTL. Never throws. */
export async function getRepoIndex(root: string): Promise<RepoIndex | null> {
  const key = String(root ?? '');
  if (!key) return null;
  const hit = indexCache.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.index;
  try {
    const index = await buildRepoIndex(key);
    indexCache.set(key, { at: Date.now(), index });
    return index;
  } catch {
    return null;
  }
}

/** Forget cached indexes (files changed on disk / project switched). */
export function invalidateRepoIndex(root?: string) {
  if (root) indexCache.delete(String(root));
  else indexCache.clear();
}

/** " (TS 12, CSS 3)" — top languages by file count. Pure. */
export function languageSummary(files: IndexedFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = LANG_LABEL[extOf(f.path)];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([lang, n]) => `${lang} ${n}`).join(', ');
  return top ? ` (${top})` : '';
}

export interface RepoMapOptions {
  maxChars?: number;
  maxFiles?: number;
  /** When set, only files relevant to this text are listed (plus a few
   *  most-imported files for context). Undefined keeps the full-map mode. */
  query?: string;
}

export const QUERY_MAX_FILES = 24;
export const CORE_MAX_FILES = 8;

// Generic English/code words that carry no file-location signal.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'we', 'you', 'i', 'me', 'my', 'our', 'your', 'he', 'she', 'they', 'them', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'just', 'please', 'help', 'fix', 'add', 'make', 'use', 'using',
  'need', 'want', 'about', 'into', 'over', 'when', 'where', 'which', 'what', 'how', 'why', 'not', 'no',
  'yes', 'all', 'any', 'some', 'more', 'most', 'also', 'only', 'so', 'up', 'down', 'out', 'than', 'there',
  'here', 'have', 'has', 'had', 'get', 'got', 'let', 'lets', 'work', 'works', 'working', 'like', 'now',
]);

/** Query tokens for retrieval: lowercased words, no stopwords, deduped. Pure. */
export function tokenizeQuery(text: string, max = 40): string[] {
  const out: string[] = [];
  for (const t of String(text ?? '').toLowerCase().split(/[^a-z0-9_$]+/)) {
    if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Split identifiers into lowercase words ("sendMessage" → send, message). */
function splitCamel(s: string): string[] {
  return String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

function relevance(f: IndexedFile, tokens: string[]): number {
  if (!tokens.length) return 0;
  const pathLower = f.path.toLowerCase();
  const pathParts = new Set(pathLower.split(/[^a-z0-9]+/).filter(Boolean).flatMap(splitCamel));
  const syms = f.symbols.map((s) => s.toLowerCase());
  const symParts = new Set(syms.flatMap(splitCamel));
  let score = 0;
  for (const t of tokens) {
    if (pathParts.has(t)) score += 8;
    else if (t.length >= 3 && pathLower.includes(t)) score += 2;
    if (symParts.has(t)) score += 6;
    else if (syms.some((s) => s.startsWith(t))) score += 3;
  }
  return score;
}

export interface RankedFiles {
  matches: IndexedFile[]; // query-relevant files, best first
  core: IndexedFile[]; // most-imported files not already matched
}

/** Select the files worth showing for one user request. Pure. */
export function rankFiles(
  files: IndexedFile[],
  query: string,
  opts: { maxFiles?: number; coreFiles?: number; scores?: Map<string, number> } = {},
): RankedFiles {
  const scores = opts.scores ?? importScores(files);
  const tokens = tokenizeQuery(query);
  const scored = files.map((f) => ({ f, rel: relevance(f, tokens), central: scores.get(f.path) ?? 0 }));
  const matches = scored
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel || b.central - a.central || byDepthThenPath(a.f, b.f))
    .slice(0, opts.maxFiles ?? QUERY_MAX_FILES)
    .map((x) => x.f);
  const shown = new Set(matches.map((f) => f.path));
  const core = scored
    .filter((x) => !shown.has(x.f.path))
    .sort((a, b) => b.central - a.central || byDepthThenPath(a.f, b.f))
    .slice(0, opts.coreFiles ?? CORE_MAX_FILES)
    .map((x) => x.f);
  return { matches, core };
}

function formatFileLine(f: IndexedFile): string {
  const lang = LANG_LABEL[extOf(f.path)];
  const tag = lang ? ` [${lang}]` : '';
  const names = f.symbols.length ? ` — ${f.symbols.join(', ')}` : '';
  return `- ${f.path}${tag}${names}`;
}

/** Render the compact repo map injected into a turn. Pure. */
export function buildRepoMap(index: RepoIndex | null | undefined, opts: RepoMapOptions = {}): string {
  const all = index?.files ?? [];
  if (!all.length) return '';
  const scores = importScores(all);
  const retrieval = opts.query !== undefined;
  const ranked = retrieval
    ? rankFiles(all, opts.query ?? '', { maxFiles: opts.maxFiles, scores })
    : {
        matches: all.slice().sort(
          (a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || byDepthThenPath(a, b),
        ),
        core: [] as IndexedFile[],
      };
  const maxChars = opts.maxChars ?? REPO_MAP_MAX_CHARS;
  const maxFiles = opts.maxFiles ?? REPO_MAP_MAX_FILES;
  const count = retrieval ? ranked.matches.length + ranked.core.length : ranked.matches.length;
  const header = [
    '## Repository map',
    retrieval
      ? `Indexed ${all.length} source files${index?.truncated ? ' (scan truncated)' : ''}${languageSummary(all)}. ` +
        (ranked.matches.length
          ? 'Files matching this request (paths + exported symbols) — read the ones you need.'
          : 'No file matched this request — showing the most-imported files for orientation.')
      : `Indexed ${all.length} source files${index?.truncated ? ' (scan truncated)' : ''}${languageSummary(all)}. ` +
        'Symbols are exported/top-level names — use this map to locate code, then read the files you need.',
  ].join('\n');
  const lines: string[] = [];
  let used = header.length + 1;
  let shown = 0;
  let omitted = 0;
  const append = (list: IndexedFile[], label?: string) => {
    if (!list.length) return;
    if (label) {
      if (used + label.length + 1 > maxChars) return;
      lines.push(label);
      used += label.length + 1;
    }
    for (const f of list) {
      if (shown >= maxFiles) {
        omitted = count - shown;
        return;
      }
      const line = formatFileLine(f);
      if (used + line.length + 1 > maxChars) {
        omitted = count - shown;
        return;
      }
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
  };
  append(ranked.matches);
  append(ranked.core, 'Most-imported files (project context):');
  if (omitted > 0) lines.push(`… (${omitted} more file${omitted === 1 ? '' : 's'} not shown)`);
  return [header, ...lines].join('\n');
}
