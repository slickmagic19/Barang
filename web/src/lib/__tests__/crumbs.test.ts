import { describe, expect, it } from 'vitest';
import { crumbSegments, crumbsOverflow } from '../crumbs';

describe('crumbSegments', () => {
  it('splits a nested file into folder crumbs plus the file', () => {
    expect(crumbSegments('web/src/ui/chat.ts')).toEqual([
      { name: 'web', path: 'web', kind: 'dir' },
      { name: 'src', path: 'web/src', kind: 'dir' },
      { name: 'ui', path: 'web/src/ui', kind: 'dir' },
      { name: 'chat.ts', path: 'web/src/ui/chat.ts', kind: 'file' },
    ]);
  });

  it('handles a root file and single-segment paths', () => {
    expect(crumbSegments('README.md')).toEqual([
      { name: 'README.md', path: 'README.md', kind: 'file' },
    ]);
  });

  it('ignores stray slashes and empty input', () => {
    expect(crumbSegments('/a//b.ts/')).toEqual([
      { name: 'a', path: 'a', kind: 'dir' },
      { name: 'b.ts', path: 'a/b.ts', kind: 'file' },
    ]);
    expect(crumbSegments('')).toEqual([]);
  });
});

describe('crumbsOverflow', () => {
  const deep = crumbSegments('a/b/c/d/e.ts');
  it('marks a trail once it gets long', () => {
    expect(crumbsOverflow(crumbSegments('a/b.ts'))).toBe(false);
    expect(crumbsOverflow(crumbSegments('web/src/ui/chat.ts'))).toBe(true);
    expect(crumbsOverflow(deep)).toBe(true);
  });
});
