import { describe, expect, it } from 'vitest';
import {
  activityLabel, bucketOf, changeStats, countSteps, dedupeFileOps, diffStats, fileOpInfo,
  fileOpsFor, fileOpsTotals, groupBucket, groupParts, isStepMarker, messagePlainText, partKind,
  planTurnActions, planTurnFiles, shouldAnimate, stepDetail, tailPath, toolLabel, toolNameOf, WORKED_ON_MIN,
} from '../chatLayout';

describe('partKind', () => {
  it('classifies prose, reasoning, media, edits and steps', () => {
    expect(partKind({ type: 'text', text: 'hi' })).toBe('prose');
    expect(partKind({})).toBe('prose');
    expect(partKind({ type: 'reasoning' })).toBe('reasoning');
    expect(partKind({ type: 'THINKING' })).toBe('reasoning');
    expect(partKind({ type: 'file' })).toBe('media');
    expect(partKind({ type: 'tool', tool: 'bash' })).toBe('step');
    expect(partKind({ type: 'tool', tool: 'read' })).toBe('step');
    expect(partKind({ type: 'tool', tool: 'edit' })).toBe('fileop');
    expect(partKind({ type: 'tool', tool: 'write' })).toBe('fileop');
    expect(partKind({ type: 'tool', tool: 'patch' })).toBe('fileop');
    expect(partKind({ type: 'step-start' })).toBe('step');
    expect(partKind(null)).toBe('prose');
  });
});

describe('toolNameOf', () => {
  it('reads the tool name off the part', () => {
    expect(toolNameOf({ tool: 'Bash' })).toBe('bash');
    expect(toolNameOf({ name: 'read' })).toBe('read');
    expect(toolNameOf({})).toBe('');
  });
});

describe('groupParts', () => {
  it('folds consecutive steps and reasoning into one trail card', () => {
    const groups = groupParts([
      { type: 'text', text: 'before' },
      { type: 'tool', tool: 'bash' },
      { type: 'reasoning' },
      { type: 'tool', tool: 'read' },
      { type: 'text', text: 'after' },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['prose', 'steps', 'prose']);
    expect(groups[1].parts).toHaveLength(3);
  });

  it('media breaks a trail instead of being swallowed by it', () => {
    const groups = groupParts([
      { type: 'tool', tool: 'a' },
      { type: 'file', filename: 'x.png' },
      { type: 'tool', tool: 'b' },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['steps', 'media', 'steps']);
  });

  it('folds consecutive file edits into one fileop group', () => {
    const groups = groupParts([
      { type: 'tool', tool: 'edit' },
      { type: 'tool', tool: 'write' },
      { type: 'text', text: 'done' },
      { type: 'tool', tool: 'patch' },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['fileops', 'prose', 'fileops']);
    expect(groups[0].parts).toHaveLength(2);
  });

  it('keeps every prose part separate', () => {
    const groups = groupParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    expect(groups.map((g) => g.kind)).toEqual(['prose', 'prose']);
    expect(groups.map((g) => g.parts.length)).toEqual([1, 1]);
  });

  it('survives empty and malformed input', () => {
    expect(groupParts([])).toEqual([]);
    expect(groupParts(null)).toEqual([]);
    // @ts-expect-error deliberately malformed entry
    expect(groupParts([null, { type: 'tool' }]).map((g) => g.kind)).toEqual(['steps']);
  });
});

describe('activity summary', () => {
  it('counts tools by bucket', () => {
    expect(countSteps([
      { type: 'tool', tool: 'read' }, { type: 'tool', tool: 'glob' },
      { type: 'tool', tool: 'bash' },
      { type: 'tool', tool: 'grep' },
      { type: 'tool', tool: 'task' },
    ])).toEqual({ files: 2, terminals: 1, searches: 1, edits: 0, other: 1 });
    expect(bucketOf({ tool: 'bash' })).toBe('terminal');
    expect(bucketOf({ tool: 'read' })).toBe('file');
    expect(bucketOf({ tool: 'grep' })).toBe('search');
    expect(bucketOf({ tool: 'wat' })).toBe('other');
  });

  it('words the row like Qoder', () => {
    expect(activityLabel([{ tool: 'read' }, { tool: 'read' }, { tool: 'read' }, { tool: 'bash' }, { tool: 'bash' }]))
      .toBe('Explored 3 files, 2 terminals');
    expect(activityLabel([{ tool: 'read' }])).toBe('Explored 1 file');
    expect(activityLabel([{ tool: 'grep' }, { tool: 'grep' }])).toBe('Explored 2 searches');
    expect(activityLabel([{ tool: 'bash' }, { tool: 'task' }])).toBe('Ran 1 terminal, 1 step');
    expect(activityLabel([{ tool: 'task' }])).toBe('Ran 1 step');
    expect(activityLabel([])).toBe('Ran 1 step');
  });

  it('picks one icon bucket for the whole row', () => {
    expect(groupBucket([{ tool: 'task' }, { tool: 'bash' }])).toBe('terminal');
    expect(groupBucket([{ tool: 'grep' }, { tool: 'read' }])).toBe('search');
    expect(groupBucket([])).toBe('other');
  });
});

describe('file cards', () => {
  it('builds a Qoder file card from an edit part', () => {
    const info = fileOpInfo({
      type: 'tool', tool: 'edit', state: 'completed',
      input: { filePath: 'c:\\proj\\web\\src\\ui\\chat.ts' },
      metadata: { diff: '--- a\n+++ b\n+one\n+two\n-gone\n' },
    });
    expect(info).toMatchObject({
      name: 'chat.ts', ext: 'TS', letter: 'M', added: 2, removed: 1, state: 'applied',
    });
  });

  it('reads the payload the server nests under state', () => {
    const info = fileOpInfo({
      type: 'tool', tool: 'write',
      state: { status: 'running', input: { filePath: 'src/ui/icons.ts' }, metadata: { diff: '+a\n+b' } },
    });
    expect(info).toMatchObject({ name: 'icons.ts', ext: 'TS', letter: 'A', added: 2, state: 'running' });
  });

  it('marks brand-new files as A and running edits as running', () => {
    expect(fileOpInfo({ tool: 'write', state: 'running', input: { path: 'a/b.md' } }))
      .toMatchObject({ name: 'b.md', ext: 'MD', letter: 'A', state: 'running', added: 0 });
    expect(fileOpInfo({ tool: 'edit', state: 'error', input: { file: 'x.json' } }))
      .toMatchObject({ ext: 'JSON', state: 'failed' });
  });

  it('returns null when there is no file to point at', () => {
    expect(fileOpInfo({ tool: 'edit', input: { command: 'ls' } })).toBeNull();
    expect(fileOpInfo(null)).toBeNull();
  });

  it('counts unified diff lines', () => {
    expect(diffStats('+++ b\n--- a\n+1\n+2\n-1')).toEqual({ added: 2, removed: 1 });
    expect(diffStats('')).toEqual({ added: 0, removed: 0 });
    expect(diffStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  it('sums the card header totals', () => {
    const a = fileOpInfo({ tool: 'edit', input: { path: 'a.ts' }, metadata: { diff: '+1\n+2' } })!;
    const b = fileOpInfo({ tool: 'write', input: { path: 'b.ts' }, metadata: { diff: '-1\n+3' } })!;
    expect(fileOpsTotals([a, b])).toEqual({ added: 3, removed: 1 });
    expect(fileOpsTotals([])).toEqual({ added: 0, removed: 0 });
  });

  it('derives stats from the edit payload when there is no diff', () => {
    expect(changeStats({ oldString: 'a\nb', newString: 'a\nb\nc' })).toEqual({ added: 3, removed: 2 });
    expect(changeStats({ content: 'one\ntwo' })).toEqual({ added: 2, removed: 0 });
    expect(changeStats({ patch: '+x\n-y' })).toEqual({ added: 1, removed: 1 });
    expect(changeStats({ unrelated: true })).toEqual({ added: 0, removed: 0 });
  });

  it('keeps one row per file and merges repeats', () => {
    const a = fileOpInfo({ tool: 'edit', input: { path: 'src/a.ts' }, metadata: { diff: '+1' } })!;
    const a2 = fileOpInfo({ tool: 'edit', input: { path: 'src/A.ts' }, metadata: { diff: '+2\n+3' } })!;
    const b = fileOpInfo({ tool: 'write', input: { path: 'src/b.ts' } })!;
    const rows = dedupeFileOps([a, a2, b, null]);
    expect(rows.map((r) => r.name)).toEqual(['a.ts', 'b.ts']);
    expect(rows[0].added).toBe(3);
  });
});

describe('tailPath', () => {
  it('keeps the readable tail of a path', () => {
    expect(tailPath('src/main.ts')).toBe('src/main.ts');
    expect(tailPath('c:\\a\\b\\c\\main.ts')).toBe('…/c/main.ts');
  });
});

describe('planTurnFiles', () => {
  const edit = (path: string) => ({ type: 'tool', tool: 'edit', input: { path } });
  const read = () => ({ type: 'tool', tool: 'read', input: { path: 'x.ts' } });

  it('plans one card per assistant run, at its last edit group', () => {
    const plans = planTurnFiles([
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', parts: [edit('a.ts'), read()] },
      { role: 'assistant', parts: [edit('b.ts')] },
      { role: 'user', parts: [{ type: 'text', text: 'next' }] },
    ]);
    expect(plans[0].total).toBe(0);
    expect(plans[1]).toMatchObject({ total: 2, isLastFileopMsg: false });
    expect(plans[2]).toMatchObject({ total: 2, isLastFileopMsg: true });
    expect(plans[2].parts).toHaveLength(2);
    expect(plans[3].total).toBe(0);
  });

  it('keeps runs apart and survives empty input', () => {
    const plans = planTurnFiles([
      { role: 'assistant', parts: [edit('a.ts')] },
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [edit('b.ts')] },
    ]);
    expect(plans[0]).toMatchObject({ total: 1, isLastFileopMsg: true });
    expect(plans[1].total).toBe(0);
    expect(plans[2]).toMatchObject({ total: 1, isLastFileopMsg: true });
    expect(planTurnFiles([])).toEqual([]);
  });
});

describe('planTurnActions', () => {
  const tool = (name: string) => ({ type: 'tool', tool: name });

  it('counts a run\'s actions and marks where the fold renders', () => {
    const plans = planTurnActions([
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'a' }, tool('read')] },
      { role: 'assistant', parts: [tool('bash'), tool('edit')] },
    ]);
    expect(plans[0].total).toBe(0);
    // Prose is not an action; edits become file cards, so they are not counted.
    expect(plans[1]).toMatchObject({ total: 2, isFirstStepMsg: true });
    expect(plans[2]).toMatchObject({ total: 2, isFirstStepMsg: false });
    expect(plans[2].groups).toHaveLength(2);
    expect(WORKED_ON_MIN).toBe(8);
  });

  it('survives empty input', () => {
    expect(planTurnActions([])).toEqual([]);
  });
});

describe('messagePlainText', () => {
  it('collects prose only, blank-line separated', () => {
    expect(messagePlainText([
      { type: 'text', text: ' first ' },
      { type: 'tool', text: 'ignored tool text' },
      { type: 'text', text: 'second' },
      { type: 'text', text: '   ' },
    ])).toBe('first\n\nsecond');
  });

  it('returns an empty string when there is nothing to copy', () => {
    expect(messagePlainText([])).toBe('');
    expect(messagePlainText([{ type: 'tool', text: 'x' }])).toBe('');
  });
});

describe('shouldAnimate', () => {
  it('animates only the tail of a long transcript', () => {
    expect(shouldAnimate(0, 10)).toBe(false);
    expect(shouldAnimate(7, 10)).toBe(false);
    expect(shouldAnimate(8, 10)).toBe(true);
    expect(shouldAnimate(9, 10)).toBe(true);
    expect(shouldAnimate(0, 2)).toBe(true);
    expect(shouldAnimate(0, 0)).toBe(false);
  });
});

describe('isStepMarker', () => {
  it('drops pure run markers, keeps real steps', () => {
    expect(isStepMarker({ type: 'step-start' })).toBe(true);
    expect(isStepMarker({ type: 'step-finish' })).toBe(true);
    expect(isStepMarker({ type: 'STEP_END' })).toBe(true);
    expect(isStepMarker({ type: 'tool' })).toBe(false);
    expect(isStepMarker({ type: 'text' })).toBe(false);
    expect(isStepMarker(null)).toBe(false);
  });
});

describe('toolLabel', () => {
  it('translates known tools into verb phrases', () => {
    expect(toolLabel('bash')).toBe('Run command');
    expect(toolLabel('Read')).toBe('Read file');
    expect(toolLabel('opencode.edit')).toBe('Edit file');
    expect(toolLabel('grep')).toBe('Search code');
    expect(toolLabel('todowrite')).toBe('Update todos');
  });

  it('returns null for unknown tools so callers keep the raw name', () => {
    expect(toolLabel('mystery-tool')).toBeNull();
    expect(toolLabel('')).toBeNull();
    expect(toolLabel(undefined)).toBeNull();
  });
});

describe('stepDetail', () => {
  it('prefers the file path, trimmed to its tail', () => {
    expect(stepDetail({ filePath: 'c:\\Users\\A\\proj\\web\\src\\ui\\chat.ts' })).toBe('…/ui/chat.ts');
    expect(stepDetail({ path: 'src/main.ts' })).toBe('src/main.ts');
  });

  it('falls back to the command, pattern or url', () => {
    expect(stepDetail({ command: 'npm test\n--watch' })).toBe('npm test');
    expect(stepDetail({ pattern: 'sess-tab' })).toBe('sess-tab');
    expect(stepDetail({ url: 'https://example.com/x' })).toBe('https://example.com/x');
  });

  it('never leaks structured JSON', () => {
    expect(stepDetail({ nested: { a: 1 } })).toBe('');
    expect(stepDetail(null)).toBe('');
    expect(stepDetail(undefined)).toBe('');
    expect(stepDetail('plain string')).toBe('plain string');
  });
});
