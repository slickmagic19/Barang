// Explorer row indicators ("tracking" markers): git state for files, a
// rolled-up change count for folders, and an unsaved-edits dot for both.
// Pure — the renderer just turns these specs into spans.

export type TreeBadgeKind = 'git' | 'count' | 'dirty';

export interface TreeBadge {
  kind: TreeBadgeKind;
  text: string;
  title: string;
  cls: string;
}

const LABELS: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Conflict', U: 'Untracked',
};

export interface TreeBadgeInput {
  isDir: boolean;
  letter?: string | null;
  count?: number;
  dirty?: boolean;
}

/** Badges for one explorer row, left→right. Files carry their git letter,
 *  folders carry the number of changed files below them; either flashes a
 *  dot while an open tab still holds unsaved edits. */
export function treeBadges(input: TreeBadgeInput): TreeBadge[] {
  const out: TreeBadge[] = [];
  if (input?.dirty) {
    out.push({ kind: 'dirty', text: '', title: 'Unsaved changes', cls: 'tree-dot' });
  }
  if (input?.isDir) {
    const n = Math.max(0, Math.floor(Number(input.count) || 0));
    if (n > 0) {
      out.push({
        kind: 'count',
        text: String(n),
        title: `${n} uncommitted change${n === 1 ? '' : 's'}`,
        cls: 'git-count',
      });
    }
    return out;
  }
  const letter = String(input?.letter ?? '');
  if (letter) {
    out.push({
      kind: 'git',
      text: letter,
      title: `Git: ${LABELS[letter] ?? letter}`,
      cls: `git-badge git-${letter}`,
    });
  }
  return out;
}

/** True when `path` is `root` itself or lives underneath it. */
export function isUnder(path: string, root: string): boolean {
  if (!root) return false;
  if (path === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix);
}

/** Does any dirty path fall inside this row? Files match exactly, folders
 *  match their subtree (so a collapsed folder still flags unsaved work). */
export function hasDirtyUnder(dirty: readonly string[], path: string, isDir: boolean): boolean {
  if (!path) return false;
  return (dirty ?? []).some((d) => (isDir ? isUnder(d, path) : d === path));
}
