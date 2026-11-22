// Memory subsystem: Qoder-style persistent memory with typed entries, a
// MEMORY.md index, scope routing (user vs project), write/update/prune, and
// system-prompt injection. Pure logic only — main-process IPC owns disk I/O.
//
// Mirrors the Qoder memory model:
//   types: user | feedback | project | reference
//   scope: user (all projects) | project (this project only)
//   index: MEMORY.md — one line per entry, never the content itself
//   files: kebab-case slugs, one memory per file, YAML-ish frontmatter

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryScope = 'user' | 'project';

export interface MemoryEntry {
  /** Kebab-case slug (== filename without .md). */
  slug: string;
  /** Short human title. */
  title: string;
  /** One-line hook for the index (<= ~150 chars). */
  hook: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Full markdown body (frontmatter stripped). */
  body: string;
  /** Absolute file path (main fills this). */
  file: string;
  /** mtime ms (main fills this; used for staleness checks). */
  mtime: number;
}

/** Parse one memory markdown file into an entry. Pure.
 *  Tolerant of missing frontmatter (title falls back to slug). */
export function parseMemoryMarkdown(
  text: string,
  hint: { slug: string; scope: MemoryScope; file?: string; mtime?: number },
): MemoryEntry | null {
  const src = String(text ?? '');
  const slug = String(hint.slug || '');
  if (!slug) return null;
  const out: MemoryEntry = {
    slug,
    title: slug,
    hook: '',
    type: 'project',
    scope: hint.scope,
    body: src,
    file: String(hint.file || ''),
    mtime: Number(hint.mtime || 0),
  };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(src);
  if (m) {
    const fm = parseFrontmatter(m[1]);
    if (typeof fm.name === 'string' && fm.name.trim()) out.slug = fm.name.trim();
    if (typeof fm.title === 'string' && fm.title.trim()) out.title = fm.title.trim();
    if (typeof fm.description === 'string' && fm.description.trim()) out.hook = fm.description.trim();
    if (fm.type === 'user' || fm.type === 'feedback' || fm.type === 'project' || fm.type === 'reference') {
      out.type = fm.type;
    } else {
      // Qoder stores type under `metadata:`; flat readers see it as a
      // top-level key, so a plain `type` at any indent wins.
      const metaType = findMetadataType(m[1]);
      if (metaType) out.type = metaType;
    }
    // Drop exactly one leading newline (serialization puts a blank line
    // between the frontmatter fence and the body for readability) and any
    // trailing blank line serialization appends.
    out.body = m[2].replace(/^\r?\n/, '').replace(/\s+$/, '');
  }
  // First non-empty body line is the hook fallback.
  if (!out.hook) {
    const first = out.body.split(/\r?\n/).find((l) => l.trim());
    out.hook = (first || '').trim().slice(0, 160);
  }
  out.title = out.title.slice(0, 200);
  out.hook = out.hook.slice(0, 200);
  return out;
}

/** Parse the small YAML subset memory frontmatter uses. Same grammar as
 *  skills (key: value, quoted/bare, # comments). Pure. */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let lastKey = '';
  let lastIndent = 0;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    // Nested block (e.g. `metadata:` → `  type: user`): record under the
    // parent key so flat readers keep working.
    if (indent > lastIndent && lastKey) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) out[kv[1]] = unquote(kv[2].trim());
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      lastIndent = indent;
      out[lastKey] = unquote(kv[2].trim());
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = String(s ?? '').trim().replace(/\s+#.*$/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/** Find a `type:` value anywhere in the frontmatter (top-level or nested
 *  under `metadata:`). Returns the first recognized memory type. */
function findMetadataType(raw: string): MemoryType | null {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv && (MEMORY_TYPES as readonly string[]).includes(unquote(kv[2].trim()))) {
      return unquote(kv[2].trim()) as MemoryType;
    }
  }
  return null;
}

/** Render a memory file's full text (frontmatter + body). Pure.
 *  Used by main to persist, and by tests to round-trip. */
export function serializeMemory(entry: {
  slug: string; title: string; hook: string; type: MemoryType; scope: MemoryScope; body: string;
}): string {
  const hook = oneLine(entry.hook);
  return [
    '---',
    `name: ${entry.slug}`,
    `title: ${JSON.stringify(oneLine(entry.title))}`,
    `description: ${JSON.stringify(hook)}`,
    `metadata:`,
    `  type: ${entry.type}`,
    '---',
    '',
    String(entry.body ?? '').trim(),
    '',
  ].join('\n');
}

/** Render the MEMORY.md index from entries. One line each, sorted by
 *  type then title. Never includes memory bodies. Pure. */
export function renderMemoryIndex(entries: MemoryEntry[]): string {
  const order: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  const sorted = (entries ?? []).slice().sort((a, b) => {
    const t = order.indexOf(a.type) - order.indexOf(b.type);
    if (t) return t;
    return a.title.localeCompare(b.title);
  });
  const lines = sorted.map((e) => `- [${e.title}](${e.slug}.md) — ${e.hook}`);
  return ['# Memory Index', '', ...lines, ''].join('\n');
}

/** Update one line in a MEMORY.md index (or append when missing). Pure.
 *  Returns the new index text. */
export function upsertIndexLine(indexText: string, entry: { slug: string; title: string; hook: string }): string {
  const line = `- [${entry.title}](${entry.slug}.md) — ${oneLine(entry.hook)}`;
  const src = String(indexText ?? '');
  const re = new RegExp(`^- \\[.*\\]\\(${escapeRe(entry.slug)}\\.md\\) — .*$`, 'm');
  if (re.test(src)) return src.replace(re, line);
  const trimmed = src.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

/** Remove one line from a MEMORY.md index. Pure. */
export function removeIndexLine(indexText: string, slug: string): string {
  const re = new RegExp(`^- \\[.*\\]\\(${escapeRe(slug)}\\.md\\) — .*$\\n?`, 'gm');
  return String(indexText ?? '').replace(re, '');
}

/** Build the memory block injected into the agent system prompt. Scoped to
 *  the current project + user scope, newest first, bodies truncated so the
 *  prompt stays bounded. Pure. */
export function memoryPromptBlock(
  entries: MemoryEntry[],
  opts: { maxChars?: number; maxEntries?: number } = {},
): string {
  const maxChars = Math.max(200, Number(opts.maxChars) || 4000);
  const maxEntries = Math.max(1, Number(opts.maxEntries) || 12);
  const list = (entries ?? [])
    .filter((e) => e && e.slug && e.body)
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, maxEntries);
  if (!list.length) return '';
  const parts: string[] = ['## Memory', 'Use these memories when relevant:'];
  let used = 0;
  for (const e of list) {
    const body = e.body.trim();
    const room = maxChars - used;
    if (room < 80) break;
    const chunk = body.length > room ? body.slice(0, room - 1) + '…' : body;
    parts.push('', `### ${e.title} (${e.scope}/${e.type})`, chunk);
    used += chunk.length + e.title.length + 32;
  }
  return parts.join('\n');
}

/** Merge two memory lists by slug (newer mtime wins). Pure. */
export function mergeMemories(a: MemoryEntry[], b: MemoryEntry[]): MemoryEntry[] {
  const bySlug = new Map<string, MemoryEntry>();
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!e || !e.slug) continue;
    const prev = bySlug.get(e.slug);
    if (!prev || (e.mtime || 0) >= (prev.mtime || 0)) bySlug.set(e.slug, e);
  }
  return [...bySlug.values()];
}

/** Validate a memory slug (kebab-case, used as filename). Pure. */
export const MEMORY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a memory write request. Returns error strings (empty = ok). Pure. */
export function validateMemoryInput(input: {
  slug?: unknown; title?: unknown; body?: unknown; type?: unknown;
}): string[] {
  const errs: string[] = [];
  const slug = String(input?.slug ?? '').trim();
  if (!MEMORY_SLUG_RE.test(slug)) errs.push('Slug: lowercase letters, numbers, dashes (e.g. user-role).');
  if (!String(input?.title ?? '').trim()) errs.push('Title is required.');
  if (!String(input?.body ?? '').trim()) errs.push('Body is required.');
  const t = String(input?.type ?? '');
  if (t && !['user', 'feedback', 'project', 'reference'].includes(t)) {
    errs.push('Type must be user, feedback, project, or reference.');
  }
  return errs;
}

function oneLine(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}