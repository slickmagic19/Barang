import { describe, expect, it } from 'vitest';
import { lineDiff, MAX_DIFF_LINES, nextChangeAt, prevChangeAt } from '../lineDiff';

describe('lineDiff', () => {
  it('reports nothing for identical files', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toEqual({
      changes: [], removed: [], deletions: [], added: 0, deleted: 0,
    });
    expect(lineDiff('', '')).toEqual({ changes: [], removed: [], deletions: [], added: 0, deleted: 0 });
  });

  it('marks a pure insertion as an add run', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual({
      changes: [{ start: 2, end: 2, kind: 'add' }],
      removed: [],
      deletions: [],
      added: 1,
      deleted: 0,
    });
  });

  it('marks an in-place rewrite as modified and keeps the old text', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual({
      changes: [{ start: 2, end: 2, kind: 'mod' }],
      removed: [{ after: 1, from: 2, lines: ['b'] }],
      deletions: [1],
      added: 1,
      deleted: 1,
    });
  });

  it('records a real deletion against the line it happened after', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual({
      changes: [],
      removed: [{ after: 1, from: 2, lines: ['b'] }],
      deletions: [1],
      added: 0,
      deleted: 1,
    });
  });

  it('handles multi-line edits on both sides', () => {
    const out = lineDiff('one\ntwo\nthree\nfour', 'one\nTWO\nthree\nfour\nfive');
    expect(out.changes).toEqual([
      { start: 2, end: 2, kind: 'mod' },
      { start: 5, end: 5, kind: 'add' },
    ]);
    expect(out.added).toBe(2);
    expect(out.deleted).toBe(1);
  });

  it('keeps deleted blocks grouped where they were removed', () => {
    const out = lineDiff('a\nx\ny\nb', 'a\nb');
    expect(out.changes).toEqual([]);
    expect(out.removed).toEqual([{ after: 1, from: 2, lines: ['x', 'y'] }]);
    expect(out.deleted).toBe(2);
  });

  it('treats a brand-new file as one added block', () => {
    expect(lineDiff('', 'x\ny')).toEqual({
      changes: [{ start: 1, end: 2, kind: 'add' }],
      removed: [],
      deletions: [],
      added: 2,
      deleted: 0,
    });
  });

  it('treats a fully emptied file as one removed block', () => {
    expect(lineDiff('x\ny', '')).toEqual({
      changes: [],
      removed: [{ after: 0, from: 1, lines: ['x', 'y'] }],
      deletions: [1],
      added: 0,
      deleted: 2,
    });
  });

  it('tolerates CRLF and a missing trailing newline', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb').changes).toEqual([]);
    expect(lineDiff('a\nb', 'a\nb\n').changes).toEqual([]);
  });

  it('finds the minimal script for a long run of small edits', () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed';
    after.splice(200, 0, 'inserted');
    const out = lineDiff(before.join('\n'), after.join('\n'));
    expect(out.changes).toEqual([
      { start: 11, end: 11, kind: 'mod' },
      { start: 201, end: 201, kind: 'add' },
    ]);
    expect(out.deleted).toBe(1);
  });

  it('degrades to a coarse band when the whole file is rewritten', () => {
    const a = Array.from({ length: 16000 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 16000 }, (_, i) => `new ${i}`).join('\n');
    const out = lineDiff(a, b);
    expect(out.changes).toEqual([{ start: 1, end: 16000, kind: 'mod' }]);
  });

  it('still diffs exactly when one line changes in a huge file', () => {
    const big = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `line ${i}`);
    const edited = [...big];
    edited[MAX_DIFF_LINES - 1] = 'edited';
    expect(lineDiff(big.join('\n'), edited.join('\n')).changes).toEqual([
      { start: MAX_DIFF_LINES, end: MAX_DIFF_LINES, kind: 'mod' },
    ]);
  });

  it('keeps huge identical files clean (trim happens before the guard)', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 200 }, (_, i) => `line ${i}`).join('\n');
    expect(lineDiff(big, big).changes).toEqual([]);
  });
});

describe('change navigation', () => {
  const changes = [
    { start: 5, end: 6, kind: 'mod' as const },
    { start: 20, end: 20, kind: 'add' as const },
    { start: 40, end: 42, kind: 'add' as const },
  ];

  it('finds the change under the caret or the next one', () => {
    expect(nextChangeAt(changes, 1)?.start).toBe(5);
    expect(nextChangeAt(changes, 6)?.start).toBe(5);
    expect(nextChangeAt(changes, 7)?.start).toBe(20);
    expect(nextChangeAt(changes, 99)).toBeNull();
  });

  it('finds the previous change before the caret', () => {
    expect(prevChangeAt(changes, 1)).toBeNull();
    expect(prevChangeAt(changes, 21)?.start).toBe(20);
    expect(prevChangeAt(changes, 99)?.start).toBe(40);
  });
});
