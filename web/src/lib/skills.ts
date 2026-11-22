// Skills subsystem: Qoder-compatible SKILL.md discovery, parsing, and
// prompt-catalog building. Pure logic (no DOM, no Node fs at import time) so
// it unit-tests in the Node vitest environment. Main-process IPC does the
// actual filesystem reads/writes; the renderer calls it through the bridge.
//
// A skill is a directory containing SKILL.md with YAML frontmatter:
//   ---
//   name: skill-name
//   description: Use when … (one-line summary for the catalog)
//   ---
//   # Title
//   Markdown body (instructions the agent loads on demand).

export interface SkillMeta {
  /** Frontmatter `name` (kebab-case slug). */
  name: string;
  /** One-line summary used in the agent catalog. */
  description: string;
  /** Source scope: bundled (shipped with app) | user | project. */
  scope: SkillScope;
  /** Directory name the skill was loaded from (== name in practice). */
  dir: string;
  /** Absolute path to the skill directory (main fills this). */
  path: string;
  /** Absolute path to SKILL.md (main fills this). */
  file: string;
  /** Body length hint (chars) — UI badge, not enforced. */
  size: number;
}

export type SkillScope = 'bundled' | 'user' | 'project';

export interface Skill extends SkillMeta {
  /** Full markdown body (frontmatter stripped). */
  body: string;
}

/** Parse a SKILL.md file's text into { meta fields, body }. Pure.
 *  Tolerant: missing frontmatter → name from caller hint, empty description.
 *  Returns null only when there is no usable name at all. */
export function parseSkillMarkdown(
  text: string,
  hint: { scope: SkillScope; dir: string; path?: string; file?: string },
): Skill | null {
  const src = String(text ?? '');
  const out: Skill = {
    name: String(hint.dir || ''),
    description: '',
    scope: hint.scope,
    dir: String(hint.dir || ''),
    path: String(hint.path || ''),
    file: String(hint.file || ''),
    size: src.length,
    body: src,
  };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (m) {
    const fm = parseFrontmatter(m[1]);
    if (typeof fm.name === 'string' && fm.name.trim()) out.name = fm.name.trim();
    if (typeof fm.description === 'string' && fm.description.trim()) out.description = fm.description.trim();
    out.body = m[2] || '';
  }
  if (!out.name) return null;
  out.size = out.body.length;
  return out;
}

/** Parse the small YAML subset SKILL.md frontmatter uses: `key: value` lines,
 *  quoted or bare values, `#` comments, and simple `- item` lists. Good enough
 *  for name/description; nested objects are ignored. Pure. */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let lastKey = '';
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      const v = unquote(kv[2].trim());
      if (v !== '' || kv[2].trim() === '') out[lastKey] = v;
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && lastKey) {
      const arr = Array.isArray(out[lastKey]) ? (out[lastKey] as string[]) : [];
      arr.push(unquote(li[1].trim()));
      out[lastKey] = arr;
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

/** Validate a skill name (used for dir names + frontmatter names). Pure. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Build the catalog block injected into the agent system prompt. One line
 *  per skill so the model knows what exists and when to load it. Pure. */
export function skillsCatalog(skills: SkillMeta[]): string {
  const list = (skills ?? []).filter((s) => s && s.name);
  if (!list.length) return '';
  const lines = list.map((s) => `- ${s.name}: ${s.description || 'No description.'}`);
  return [
    '## Available Skills',
    'When a task matches one of these skills, load its full instructions by',
    'reading the skill body below before acting:',
    ...lines,
  ].join('\n');
}

/** Render the full body of one skill (for "load this skill" flows). Pure. */
export function skillBody(skill: Skill | null | undefined): string {
  if (!skill || !skill.body) return '';
  return `# Skill: ${skill.name}\n\n${skill.body}`;
}

/** Merge skill lists by name, later scopes overriding earlier ones
 *  (bundled < user < project). Pure. */
export function mergeSkills(...lists: SkillMeta[][]): SkillMeta[] {
  const byName = new Map<string, SkillMeta>();
  for (const list of lists) {
    for (const s of list ?? []) {
      if (s && s.name) byName.set(s.name, s);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Group skills by scope for the settings UI. Pure. */
export function skillsByScope(skills: SkillMeta[]): Record<SkillScope, SkillMeta[]> {
  const out: Record<SkillScope, SkillMeta[]> = { bundled: [], user: [], project: [] };
  for (const s of skills ?? []) {
    (out[s.scope] ??= []).push(s);
  }
  return out;
}