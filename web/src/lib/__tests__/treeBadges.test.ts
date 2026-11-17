import { describe, expect, it } from 'vitest';
import { hasDirtyUnder, isUnder, treeBadges } from '../treeBadges';

describe('treeBadges — files', () => {
  it('shows the git letter with a readable title', () => {
    const badges = treeBadges({ isDir: false, letter: 'M' });
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ kind: 'git', text: 'M', cls: 'git-badge git-M' });
    expect(badges[0].title).toContain('Modified');
  });

  it('puts the unsaved dot before the git letter', () => {
    const badges = treeBadges({ isDir: false, letter: 'A', dirty: true });
    expect(badges.map((b) => b.kind)).toEqual(['dirty', 'git']);
    expect(badges[1].cls).toBe('git-badge git-A');
  });

  it('renders nothing for clean files', () => {
    expect(treeBadges({ isDir: false, letter: null })).toEqual([]);
    expect(treeBadges({ isDir: false })).toEqual([]);
  });

  it('keeps unknown codes visible instead of dropping them', () => {
    const badges = treeBadges({ isDir: false, letter: 'T' });
    expect(badges[0]).toMatchObject({ text: 'T', title: 'Git: T' });
  });
});

describe('treeBadges — folders', () => {
  it('shows the rolled-up change count with a pluralized tooltip', () => {
    expect(treeBadges({ isDir: true, count: 1 })).toEqual([
      { kind: 'count', text: '1', title: '1 uncommitted change', cls: 'git-count' },
    ]);
    expect(treeBadges({ isDir: true, count: 4 })[0].title).toBe('4 uncommitted changes');
  });

  it('hides the count at zero and ignores file letters on folders', () => {
    expect(treeBadges({ isDir: true, count: 0 })).toEqual([]);
    expect(treeBadges({ isDir: true, count: -2 })).toEqual([]);
    expect(treeBadges({ isDir: true, count: NaN })).toEqual([]);
    expect(treeBadges({ isDir: true, letter: 'M', count: 0 })).toEqual([]);
  });

  it('still flags unsaved work when the folder only has dirty children', () => {
    const badges = treeBadges({ isDir: true, count: 0, dirty: true });
    expect(badges).toEqual([{ kind: 'dirty', text: '', title: 'Unsaved changes', cls: 'tree-dot' }]);
  });
});

describe('isUnder', () => {
  it('matches the folder itself and its subtree only', () => {
    expect(isUnder('src', 'src')).toBe(true);
    expect(isUnder('src/a.ts', 'src')).toBe(true);
    expect(isUnder('srcx/a.ts', 'src')).toBe(false);
    expect(isUnder('a.ts', '.')).toBe(false);
    expect(isUnder('a.ts', '')).toBe(false);
  });
});

describe('hasDirtyUnder', () => {
  const dirty = ['src/ui/chat.ts', 'README.md'];

  it('matches files exactly', () => {
    expect(hasDirtyUnder(dirty, 'README.md', false)).toBe(true);
    expect(hasDirtyUnder(dirty, 'src/ui/chat.ts', false)).toBe(true);
    expect(hasDirtyUnder(dirty, 'src/ui/menu.ts', false)).toBe(false);
  });

  it('matches folders by subtree so collapsed folders still flag', () => {
    expect(hasDirtyUnder(dirty, 'src', true)).toBe(true);
    expect(hasDirtyUnder(dirty, 'src/ui', true)).toBe(true);
    expect(hasDirtyUnder(dirty, 'web', true)).toBe(false);
    expect(hasDirtyUnder([], 'src', true)).toBe(false);
  });
});
