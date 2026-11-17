import { describe, expect, it } from 'vitest';
import { ancestorsOf, buildDecorations, codeOf, dirOf, letterOf } from '../gitDeco';

describe('letterOf', () => {
  it('maps porcelain codes to VSCode letters', () => {
    expect(letterOf('M')).toBe('M');
    expect(letterOf('?')).toBe('U'); // untracked renders as U
    expect(letterOf(' ')).toBe('');
    expect(letterOf('')).toBe('');
    expect(letterOf(undefined)).toBe('');
  });
});

describe('codeOf', () => {
  it('prefers the worktree side over the staged side', () => {
    expect(codeOf({ path: 'a.ts', index: 'A', work: 'M' })).toBe('M');
    expect(codeOf({ path: 'a.ts', index: 'A', work: ' ' })).toBe('A');
    expect(codeOf({ path: 'a.ts', index: '', work: '' })).toBe('');
    expect(codeOf({ path: 'a.ts', work: '?' })).toBe('U');
  });
});

describe('dirOf / ancestorsOf', () => {
  it('resolves folders with the root as "."', () => {
    expect(dirOf('README.md')).toBe('.');
    expect(dirOf('src/main.ts')).toBe('src');
    expect(dirOf('src/ui/chat.ts')).toBe('src/ui');
    expect(ancestorsOf('src/ui/chat.ts')).toEqual(['src/ui', 'src', '.']);
    expect(ancestorsOf('README.md')).toEqual(['.']);
  });
});

describe('buildDecorations', () => {
  it('marks files and rolls changes up every ancestor folder', () => {
    const deco = buildDecorations([
      { path: 'src/ui/chat.ts', work: 'M' },
      { path: 'src/main.ts', work: '?' },
      { path: 'README.md', index: 'A', work: ' ' },
      { path: 'src/clean.ts', work: ' ' }, // untouched — ignored
    ]);
    expect(deco.files.get('src/ui/chat.ts')).toBe('M');
    expect(deco.files.get('src/main.ts')).toBe('U');
    expect(deco.files.get('README.md')).toBe('A');
    expect(deco.files.has('src/clean.ts')).toBe(false);
    expect(deco.dirs.get('.')).toBe(3);
    expect(deco.dirs.get('src')).toBe(2);
    expect(deco.dirs.get('src/ui')).toBe(1);
  });

  it('survives partial/empty input', () => {
    expect(buildDecorations([]).dirs.size).toBe(0);
    expect(buildDecorations(null as never).files.size).toBe(0);
    const deco = buildDecorations([{ path: '' }, { path: 'a.ts' }]);
    expect(deco.files.size).toBe(0);
  });
});
