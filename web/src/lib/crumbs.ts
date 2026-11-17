// Breadcrumb helpers for the editor header (VS Code/Qoder style):
// `web › src › ui › chat.ts › …`. Pure so the segmentation is unit-tested.

export interface CrumbSegment {
  name: string;
  path: string;
  kind: 'dir' | 'file';
}

/** Split a project-relative file path into clickable breadcrumb segments.
 *  Trailing slashes are ignored; an empty path yields no crumbs. */
export function crumbSegments(filePath: string): CrumbSegment[] {
  const parts = String(filePath ?? '').split('/').map((p) => p.trim()).filter(Boolean);
  return parts.map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join('/'),
    kind: i === parts.length - 1 ? 'file' : 'dir',
  }));
}

/** True when the crumb trail is deep enough to need a trailing overflow mark
 *  (Qoder shows `web › src › ui › chat.ts › …`). */
export function crumbsOverflow(segments: readonly CrumbSegment[], max = 3): boolean {
  return segments.length > max;
}
