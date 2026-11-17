// Line-level diff for the editor's inline changes view (HEAD vs buffer).
// Myers O(ND): fast and minimal on ordinary edits, exactly like git's own
// algorithm — a 2k-line file with a few hundred edits diffs in a few ms.
// Pure and unit-tested (__tests__/lineDiff.test.ts); the changed-line sets are
// verified against `git diff -U0` output.

export type ChangeKind = 'add' | 'mod';

export interface LineChange {
  start: number; // 1-based, inclusive, in the NEW file
  end: number; // 1-based, inclusive
  kind: ChangeKind;
}

/** Lines that exist only in HEAD, anchored after a NEW-file line (0 = top). */
export interface RemovedBlock {
  after: number; // new-file line the block hangs off (0 = above line 1)
  from: number; // 1-based line number in HEAD (for the phantom gutter)
  lines: string[];
}

export interface LineDiffResult {
  changes: LineChange[];
  removed: RemovedBlock[];
  deletions: number[]; // new-file line each removal hangs off (1-based)
  added: number; // inserted lines
  deleted: number; // removed lines
}

const EMPTY: LineDiffResult = { changes: [], removed: [], deletions: [], added: 0, deleted: 0 };

/** Guard: below this many edits Myers runs; past it we band the middle. */
export const MAX_EDIT_DISTANCE = 1500;

/** Guard: files bigger than this (after trimming) only get a coarse band. */
export const MAX_DIFF_LINES = 30_000;

type Op = { eq: number } | { ins: string[] } | { del: string[] };

function splitLines(text: string): string[] {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (t === '') return [];
  return t.replace(/\n$/, '').split('\n');
}

export function lineDiff(before: string, after: string): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  if (!b.length && !a.length) return EMPTY;
  if (!a.length) {
    return { changes: [{ start: 1, end: b.length, kind: 'add' }], removed: [], deletions: [], added: b.length, deleted: 0 };
  }
  if (!b.length) {
    return { changes: [], removed: [{ after: 0, from: 1, lines: a }], deletions: [1], added: 0, deleted: a.length };
  }

  // Common prefix/suffix shrink the search window; Myers stays identical.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  if (!ma.length && !mb.length) return EMPTY;
  if (ma.length + mb.length > MAX_DIFF_LINES) return coarse(a, b);
  const ops = ma.length || mb.length ? myers(ma, mb) : [];
  if (!ops) return coarse(a, b);
  return build(ops, pre);
}

function coarse(a: string[], b: string[]): LineDiffResult {
  return {
    changes: [{ start: 1, end: b.length, kind: 'mod' }],
    removed: [],
    deletions: [1],
    added: b.length,
    deleted: a.length,
  };
}

/** Walk one edit script into runs, removed blocks and stats. */
function build(ops: Op[], prefix: number): LineDiffResult {
  const changes: LineChange[] = [];
  const removed: RemovedBlock[] = [];
  let ln = 0; // new-file lines consumed so far
  let oldLn = 0; // HEAD lines consumed so far
  let pendingDel: string[] = [];
  let pendingFrom = 0;
  let added = 0;
  let deleted = 0;

  const flushDel = (atLine: number) => {
    if (!pendingDel.length) return;
    removed.push({ after: atLine, from: pendingFrom, lines: pendingDel });
    pendingDel = [];
  };

  for (const op of ops) {
    if ('eq' in op) {
      flushDel(ln);
      ln += op.eq;
      oldLn += op.eq;
    } else if ('del' in op) {
      if (!pendingDel.length) pendingFrom = prefix + oldLn + 1;
      pendingDel.push(...op.del);
      oldLn += op.del.length;
      deleted += op.del.length;
    } else {
      const start = ln + 1;
      const end = ln + op.ins.length;
      ln = end;
      added += op.ins.length;
      const kind: ChangeKind = pendingDel.length ? 'mod' : 'add';
      flushDel(start - 1);
      const prev = changes[changes.length - 1];
      if (prev && prev.end === start - 1) {
        prev.end = end;
        if (kind === 'mod') prev.kind = 'mod';
      } else {
        changes.push({ start, end, kind });
      }
    }
  }
  flushDel(ln);

  const deletions = [...new Set(removed.map((r) => Math.max(1, prefix + r.after)))];
  return {
    changes: changes.map((c) => ({ start: prefix + c.start, end: prefix + c.end, kind: c.kind })),
    removed: removed.map((r) => ({ after: prefix + r.after, from: r.from, lines: r.lines })),
    deletions,
    added,
    deleted,
  };
}

/** Myers diff → edit script. Null when the edit distance blows the cap. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(MAX_EDIT_DISTANCE, max);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // k in [-(d+1), d+1]
    for (let k = -d; k <= d; k += 2) {
      const x0 = (k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]))
        ? v[k + 1 + off]
        : v[k - 1 + off] + 1;
      let x = x0;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + off] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, off);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dist: number, off: number): Op[] {
  const at = (d: number, k: number) => trace[d][k + d + 1];
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dist; d > 0; d--) {
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(d, k - 1) < at(d, k + 1))) ? k + 1 : k - 1;
    const prevX = at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ eq: 1 });
      x--; y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push({ ins: [b[y - 1]] });
      y--;
    } else {
      ops.push({ del: [a[x - 1]] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ eq: 1 });
    x--; y--;
  }
  ops.reverse();
  return mergeOps(ops);
}

/** Collapse runs so the build step sees long, cheap-to-walk ops. */
function mergeOps(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && 'eq' in op && 'eq' in prev) prev.eq += op.eq;
    else if (prev && 'ins' in op && 'ins' in prev) prev.ins.push(...op.ins);
    else if (prev && 'del' in op && 'del' in prev) prev.del.push(...op.del);
    else out.push('eq' in op ? { eq: op.eq } : 'ins' in op ? { ins: [...op.ins] } : { del: [...op.del] });
  }
  return out;
}

/** First changed line at or after `line` (for change navigation). */
export function nextChangeAt(changes: readonly LineChange[], line: number): LineChange | null {
  return changes.find((c) => c.end >= line) ?? null;
}

/** Last changed line before `line`. */
export function prevChangeAt(changes: readonly LineChange[], line: number): LineChange | null {
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i].start < line) return changes[i];
  return null;
}
