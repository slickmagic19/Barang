import { describe, expect, it } from 'vitest';
import { previewVictim, staysPinned } from '../previewTabs';

describe('previewVictim', () => {
  const tabs = [
    { path: 'a.ts', group: 1 },
    { path: 'b.ts', group: 1, transient: true },
    { path: 'c.ts', group: 2, transient: true },
  ];

  it('replaces only the transient tab of the same group', () => {
    expect(previewVictim(tabs, 1, 'd.ts')?.path).toBe('b.ts');
    expect(previewVictim(tabs, 2, 'd.ts')?.path).toBe('c.ts');
  });

  it('keeps the tab when it is the file being previewed again', () => {
    expect(previewVictim(tabs, 1, 'b.ts')).toBeNull();
  });

  it('never evicts permanent tabs', () => {
    expect(previewVictim([{ path: 'a.ts', group: 1 }], 1, 'b.ts')).toBeNull();
    expect(previewVictim([], 1, 'b.ts')).toBeNull();
  });

  it('picks the last transient tab when several slipped through', () => {
    const many = [
      { path: 'a.ts', group: 1, transient: true },
      { path: 'b.ts', group: 1, transient: true },
    ];
    expect(previewVictim(many, 1, 'c.ts')?.path).toBe('b.ts');
  });
});

describe('staysPinned', () => {
  it('pinned tabs survive the next preview', () => {
    expect(staysPinned({ path: 'a.ts' })).toBe(true);
    expect(staysPinned({ path: 'a.ts', transient: true })).toBe(false);
  });
});