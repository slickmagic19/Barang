import { describe, expect, it } from 'vitest';
import { focusForSelection, isSelectedRow, pruneFocus } from '../treeFocus';

describe('pruneFocus', () => {
  const fileA = { path: 'a.ts', type: 'file' as const };
  const dir = { path: 'src', type: 'dir' as const };

  it('keeps a file focus only while that file is the selection', () => {
    expect(pruneFocus(fileA, 'a.ts')).toEqual(fileA);
    // Another file became active: the old row must stop drawing a focus mark.
    expect(pruneFocus(fileA, 'b.ts')).toBeNull();
    expect(pruneFocus(fileA, null)).toBeNull();
  });

  it('leaves folder focus alone (it is a create target)', () => {
    expect(pruneFocus(dir, 'a.ts')).toEqual(dir);
    expect(pruneFocus(dir, null)).toEqual(dir);
  });

  it('handles no focus at all', () => {
    expect(pruneFocus(null, 'a.ts')).toBeNull();
  });
});

describe('focusForSelection', () => {
  it('makes the open file the create target', () => {
    expect(focusForSelection('web/src/ui/chat.ts')).toEqual({
      path: 'web/src/ui/chat.ts',
      type: 'file',
    });
  });
});

describe('isSelectedRow', () => {
  it('marks the selected row, file or folder alike', () => {
    expect(isSelectedRow('web/src', 'web/src')).toBe(true);
    expect(isSelectedRow('web/src', 'web')).toBe(false);
    expect(isSelectedRow('src/ui/chat.ts', 'src/ui/chat.ts')).toBe(true);
  });

  it('marks nothing when there is no selection', () => {
    expect(isSelectedRow(null, 'web/src')).toBe(false);
    expect(isSelectedRow('', 'web/src')).toBe(false);
  });
});
