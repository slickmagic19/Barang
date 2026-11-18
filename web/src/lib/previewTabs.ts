// VSCode preview tabs: a single click in the explorer opens a PREVIEW tab,
// which the next preview replaces. Double-clicking the row or the tab pins it,
// and any edit pins it too. Pure helpers so the rule is unit-tested.

export interface PreviewTabLike {
  path: string;
  group?: number;
  transient?: boolean;
}

/** The transient tab a new preview replaces: same group, not the same file.
 *  Permanent tabs (and other groups) are never touched. */
export function previewVictim<T extends PreviewTabLike>(
  tabs: readonly T[],
  group: number,
  incoming: string,
): T | null {
  let victim: T | null = null;
  for (const t of tabs) {
    if (!t.transient) continue;
    if ((t.group || 1) !== group) continue;
    if (t.path === incoming) continue;
    victim = t; // last wins: there should only ever be one
  }
  return victim;
}

/** Should this tab be kept when the user opens something else as a preview? */
export function staysPinned(tab: PreviewTabLike): boolean {
  return !tab.transient;
}