// Transcript layout model for the agent panel. Everything the renderer needs
// to draw a Qoder-style turn: which parts are prose, which are tool activity
// (folded into one "Explored 3 files, 5 terminals" row), which are file edits
// (their own card, batched when long), and how tool names/args read.
// Pure — no DOM (unit-tested in lib/__tests__/chatLayout.test.ts).

export type PartKind = 'prose' | 'step' | 'reasoning' | 'media' | 'fileop';

export interface ChatPart {
  type?: unknown;
  tool?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

/** Lower-cased tool/name carried by a part (opencode puts it on `tool`). */
export function toolNameOf(part: ChatPart | null | undefined): string {
  return String(part?.tool ?? part?.name ?? '').trim().toLowerCase();
}

/** Tools that change a file on disk — Qoder renders these as file cards. */
export const FILE_TOOLS = new Set([
  'edit', 'write', 'patch', 'multiedit', 'apply_patch', 'applypatch', 'str_replace', 'create',
]);

/** Classify one server part. Mirrors the render branches in ui/chat.ts. */
export function partKind(part: ChatPart | null | undefined): PartKind {
  const t = typeof part?.type === 'string' ? part.type.toLowerCase() : '';
  if (!t || t === 'text') return 'prose';
  if (t.includes('reason') || t.includes('think')) return 'reasoning';
  if (t === 'file') return 'media';
  const tool = toolNameOf(part);
  if (FILE_TOOLS.has(tool) || /(^|[^a-z])(edit|write|patch)([^a-z]|$)/.test(t)) return 'fileop';
  return 'step';
}

export type GroupKind = 'prose' | 'steps' | 'fileops' | 'media';

export interface PartGroup {
  kind: GroupKind;
  parts: ChatPart[];
}

/** Group parts for rendering: consecutive activity folds into ONE block,
 *  consecutive edits fold into a file-op group (batched when long), prose and
 *  media always stand alone so they read as content. */
export function groupParts(parts: readonly ChatPart[] | null | undefined): PartGroup[] {
  const groups: PartGroup[] = [];
  for (const p of parts ?? []) {
    if (!p || typeof p !== 'object') continue;
    const kind = partKind(p);
    if (kind === 'step' || kind === 'reasoning') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'steps') last.parts.push(p);
      else groups.push({ kind: 'steps', parts: [p] });
      continue;
    }
    if (kind === 'fileop') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'fileops') last.parts.push(p);
      else groups.push({ kind: 'fileops', parts: [p] });
      continue;
    }
    groups.push({ kind: kind === 'media' ? 'media' : 'prose', parts: [p] });
  }
  return groups;
}

/** Copyable text of a message: prose parts only, blank-line separated. */
export function messagePlainText(parts: readonly ChatPart[] | null | undefined): string {
  const chunks: string[] = [];
  for (const p of parts ?? []) {
    if (!p || typeof p !== 'object') continue;
    if (partKind(p) !== 'prose') continue;
    if (typeof p.text === 'string' && p.text.trim()) chunks.push(p.text.trim());
  }
  return chunks.join('\n\n');
}

/** Tail-only enter animation: a rebuilt transcript must not replay the whole
 *  history, so only the newest messages (and rows) animate. */
export function shouldAnimate(index: number, total: number, windowSize = 2): boolean {
  return total > 0 && index >= total - Math.max(1, windowSize);
}

/** Pure run markers (step-start / step-finish) carry no content — Qoder hides
 *  them and shows only the meaningful steps between. */
export function isStepMarker(part: ChatPart | null | undefined): boolean {
  const t = typeof part?.type === 'string' ? part.type.toLowerCase() : '';
  return /^step[-_ ]?(start|finish|end)$/.test(t);
}

// ---- activity rows -------------------------------------------------------

export type StepBucket = 'file' | 'terminal' | 'search' | 'edit' | 'other';

const BUCKETS: Record<string, StepBucket> = {
  read: 'file', readfile: 'file', list: 'file', ls: 'file', glob: 'file', find: 'file', view: 'file',
  bash: 'terminal', shell: 'terminal', exec: 'terminal', terminal: 'terminal', command: 'terminal',
  grep: 'search', search: 'search', websearch: 'search', webfetch: 'search', fetch: 'search',
  edit: 'edit', write: 'edit', patch: 'edit', multiedit: 'edit', apply_patch: 'edit',
};

/** Coarse bucket a tool belongs to (drives the row icon + summary wording). */
export function bucketOf(part: ChatPart | null | undefined): StepBucket {
  const tool = toolNameOf(part);
  return BUCKETS[tool] ?? 'other';
}

export interface StepCounts {
  files: number;
  terminals: number;
  searches: number;
  edits: number;
  other: number;
}

/** Count activity by bucket (pure; the renderer words it). */
export function countSteps(parts: readonly ChatPart[] | null | undefined): StepCounts {
  const out: StepCounts = { files: 0, terminals: 0, searches: 0, edits: 0, other: 0 };
  for (const p of parts ?? []) {
    if (!p || typeof p !== 'object') continue;
    switch (bucketOf(p)) {
      case 'file': out.files++; break;
      case 'terminal': out.terminals++; break;
      case 'search': out.searches++; break;
      case 'edit': out.edits++; break;
      default: out.other++;
    }
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One-line summary of a run of activity, Qoder style:
 *  "Explored 3 files, 5 terminals" / "Searched 2 patterns" / "Ran 4 steps". */
export function activityLabel(parts: readonly ChatPart[] | null | undefined): string {
  const c = countSteps(parts);
  const bits: string[] = [];
  if (c.files) bits.push(plural(c.files, 'file'));
  if (c.terminals) bits.push(plural(c.terminals, 'terminal'));
  if (c.searches) bits.push(plural(c.searches, 'search', 'searches'));
  if (c.edits) bits.push(plural(c.edits, 'file edit'));
  if (!bits.length) {
    const n = c.other || (parts?.length ?? 0);
    return `Ran ${plural(Math.max(1, n), 'step')}`;
  }
  if (c.other) bits.push(plural(c.other, 'step'));
  const explored = c.other === 0 && c.edits === 0;
  return `${explored ? 'Explored' : 'Ran'} ${bits.join(', ')}`;
}

// ---- file cards ----------------------------------------------------------

export interface FileOpInfo {
  path: string; // project-relative (or absolute) path as reported
  name: string; // basename
  ext: string; // uppercased language badge ("TS", "JSON", …)
  letter: 'A' | 'M'; // added vs modified
  added: number;
  removed: number;
  state: string; // running | applied | failed
}

const EXT_BADGE: Record<string, string> = {
  ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', mjs: 'MJS', cjs: 'CJS',
  json: 'JSON', md: 'MD', css: 'CSS', scss: 'SCSS', html: 'HTML',
  py: 'PY', rs: 'RS', go: 'GO', java: 'JAVA', sh: 'SH', yml: 'YML', yaml: 'YAML',
};

/** Diff stats out of whatever the server attached (unified patch or head/tail). */
export function diffStats(diff: unknown): { added: number; removed: number } {
  if (typeof diff !== 'string' || !diff) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** Everything a file card needs, or null when the part is not a file edit. */
export function fileOpInfo(part: ChatPart | null | undefined): FileOpInfo | null {
  if (!part || typeof part !== 'object') return null;
  // The server nests input/metadata/status under `state`.
  const stateObj = part.state && typeof part.state === 'object' && !Array.isArray(part.state)
    ? part.state as Record<string, unknown>
    : {};
  const input = (part.input ?? part.args ?? part.arguments ?? stateObj.input ?? {}) as Record<string, unknown>;
  const rawPath = input.filePath ?? input.path ?? input.file ?? input.filename ?? part.title;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const path = rawPath.trim();
  const name = path.split(/[\\/]/).pop() || path;
  const ext = (name.includes('.') ? name.split('.').pop()! : '').toLowerCase();
  const meta = ((stateObj.metadata ?? part.metadata) ?? {}) as Record<string, unknown>;
  const stats = changeStats(meta.diff ?? part.diff ?? input);
  const tool = toolNameOf(part);
  const created = meta.exists === false || tool === 'write' || tool === 'create';
  const state = (typeof part.state === 'string'
    ? part.state
    : String(stateObj.status ?? part.status ?? '')).toLowerCase();
  const label = /error|fail/.test(state) ? 'failed'
    : /run|progress|start|pending/.test(state) ? 'running'
      : 'applied';
  return {
    path,
    name,
    ext: EXT_BADGE[ext] ?? (ext ? ext.slice(0, 4).toUpperCase() : 'TXT'),
    letter: created ? 'A' : 'M',
    added: stats.added,
    removed: stats.removed,
    state: label,
  };
}

const countLines = (s: string) => (s ? s.split('\n').length : 0);

/** Line stats for an edit: prefer a real unified diff, else the edit payload
 *  (old/new strings, whole-file content) the tool carried. */
export function changeStats(source: unknown): { added: number; removed: number } {
  if (typeof source === 'string') return diffStats(source);
  if (!source || typeof source !== 'object') return { added: 0, removed: 0 };
  const o = source as Record<string, unknown>;
  const unified = [o.diff, o.patch, o.unified].find((v): v is string => typeof v === 'string' && !!v);
  if (unified) return diffStats(unified);
  const oldStr = typeof o.oldString === 'string' ? o.oldString : '';
  const newStr = typeof o.newString === 'string' ? o.newString : '';
  if (oldStr || newStr) return { added: countLines(newStr), removed: countLines(oldStr) };
  if (typeof o.content === 'string' && o.content) return { added: countLines(o.content), removed: 0 };
  return { added: 0, removed: 0 };
}

/** One row per file (Qoder counts files, not edits): repeated edits to the
 *  same path merge their stats, last state wins. */
export function dedupeFileOps(infos: readonly (FileOpInfo | null)[] | null | undefined): FileOpInfo[] {
  const order: string[] = [];
  const byPath = new Map<string, FileOpInfo>();
  for (const info of infos ?? []) {
    if (!info) continue;
    const key = info.path.toLowerCase();
    const prev = byPath.get(key);
    if (prev) {
      // First sighting keeps the display name; stats add up, state is latest.
      byPath.set(key, {
        ...prev,
        added: prev.added + info.added,
        removed: prev.removed + info.removed,
        state: info.state,
        letter: info.letter,
      });
    } else {
      byPath.set(key, { ...info });
      order.push(key);
    }
  }
  return order.map((k) => byPath.get(k)!);
}

/** File-card infos for a run of edit parts, one per file. */
export function fileOpsFor(parts: readonly ChatPart[] | null | undefined): FileOpInfo[] {
  return dedupeFileOps((parts ?? []).map((p) => fileOpInfo(p)));
}

/** Batch threshold: Qoder folds long runs of edits into "N Files Changed". */
export const FILE_BATCH_MIN = 3;

/** From this many actions on, a turn collapses its steps into Qoder's
 *  "Worked on N actions" line instead of listing every step inline. */
export const WORKED_ON_MIN = 8;

export interface TurnActionPlan {
  total: number; // step/reasoning parts in the run
  isFirstStepMsg: boolean; // render the collapsed summary on this message
  groups: ChatPart[][]; // step groups of the run, in order (details body)
}

/** Plan the per-turn activity summary: how many actions, where to render the
 *  folded "Worked on N actions" line, and every group it reveals. */
export function planTurnActions(
  rows: readonly { role: string; parts: readonly ChatPart[] }[],
): TurnActionPlan[] {
  const plans: TurnActionPlan[] = rows.map(() => ({ total: 0, isFirstStepMsg: false, groups: [] }));
  let i = 0;
  while (i < rows.length) {
    const role = rows[i].role;
    let end = i;
    while (end < rows.length && rows[end].role === role) end++;
    if (role !== 'user') {
      const groups: ChatPart[][] = [];
      let total = 0;
      let first = -1;
      for (let k = i; k < end; k++) {
        for (const g of groupParts(rows[k].parts)) {
          if (g.kind !== 'steps') continue;
          if (first < 0) first = k;
          total += g.parts.length;
          groups.push(g.parts);
        }
      }
      for (let k = i; k < end; k++) {
        plans[k] = { total, isFirstStepMsg: k === first, groups };
      }
    }
    i = end;
  }
  return plans;
}

/** Header totals for the "N Files Changed" card (+742 -255). */
export function fileOpsTotals(infos: readonly FileOpInfo[] | null | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const i of infos ?? []) {
    if (!i) continue;
    added += i.added;
    removed += i.removed;
  }
  return { added, removed };
}

export interface TurnFilePlan {
  total: number; // file edits made by this assistant run
  isLastFileopMsg: boolean; // this message holds the run's last edit group
  parts: ChatPart[]; // every edit part of the run, in order
}

/** Qoder summarizes a whole assistant run's edits in ONE card. Editors rarely
 *  emit 3+ edits back-to-back (reads and commands interleave), so the card is
 *  planned per run: how many edits, where the last one sits, and all of them. */
export function planTurnFiles(
  rows: readonly { role: string; parts: readonly ChatPart[] }[],
): TurnFilePlan[] {
  const plans: TurnFilePlan[] = rows.map(() => ({ total: 0, isLastFileopMsg: false, parts: [] }));
  let i = 0;
  while (i < rows.length) {
    const role = rows[i].role;
    let end = i;
    while (end < rows.length && rows[end].role === role) end++;
    if (role !== 'user') {
      const parts: ChatPart[] = [];
      let last = -1;
      for (let k = i; k < end; k++) {
        const own = rows[k].parts.filter((p) => partKind(p) === 'fileop');
        if (own.length) last = k;
        parts.push(...own);
      }
      for (let k = i; k < end; k++) {
        plans[k] = { total: parts.length, isLastFileopMsg: k === last, parts };
      }
    }
    i = end;
  }
  return plans;
}

// ---- tool labels ---------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  bash: 'Run command', shell: 'Run command', terminal: 'Run command', exec: 'Run command',
  read: 'Read file', cat: 'Read file',
  write: 'Write file', edit: 'Edit file', multiedit: 'Edit file', patch: 'Apply patch',
  grep: 'Search code', glob: 'Find files', list: 'List files', ls: 'List files',
  webfetch: 'Fetch page', websearch: 'Search web',
  todowrite: 'Update todos', todoread: 'Read todos',
  task: 'Delegate task',
};

/** Human label for a tool row ("Read file", "Run command"). Null when the
 *  tool is unknown — callers keep the raw name then. */
export function toolLabel(tool: string | null | undefined): string | null {
  const key = String(tool ?? '').trim().toLowerCase().replace(/^[\w]*\./, '');
  return TOOL_LABELS[key] ?? null;
}

/** One-line detail for a step row: the file it touched, the command it ran,
 *  or the pattern it searched for (never raw JSON). */
export function stepDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 80) : '';
  const o = input as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const path = pick(o.filePath) || pick(o.path) || pick(o.file) || pick(o.filename);
  if (path) return tailPath(path);
  const cmd = pick(o.command) || pick(o.cmd) || pick(o.script);
  if (cmd) return cmd.split('\n')[0].slice(0, 80);
  const pattern = pick(o.pattern) || pick(o.query);
  if (pattern) return pattern.slice(0, 60);
  const url = pick(o.url);
  if (url) return url.slice(0, 60);
  return '';
}

/** Last two path segments ("…/ui/chat.ts") — readable at panel width. */
export function tailPath(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

/** Row icon bucket for a whole activity group (first non-other wins). */
export function groupBucket(parts: readonly ChatPart[] | null | undefined): StepBucket {
  const order: StepBucket[] = ['terminal', 'search', 'file', 'edit', 'other'];
  const seen = new Set<StepBucket>();
  for (const p of parts ?? []) seen.add(bucketOf(p));
  return order.find((b) => seen.has(b)) ?? 'other';
}
