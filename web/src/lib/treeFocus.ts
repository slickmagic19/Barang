// Explorer focus bookkeeping. The tree keeps two marks: the open file
// (`selected`) and the entry the New File/Folder toolbar targets (`focused`).
// A focused FILE can go stale the moment another file becomes active — that
// stale row is what reads as a "ghost" second selector. Folder focus is a
// deliberate create target and survives selection changes.

export interface FocusEntry {
  path: string;
  type: 'file' | 'dir';
}

/** Drop a file focus that no longer matches the selected file. */
export function pruneFocus(focused: FocusEntry | null, selected: string | null): FocusEntry | null {
  if (!focused) return null;
  if (focused.type === 'dir') return focused;
  return focused.path === selected ? focused : null;
}

/** Focus used when a file becomes the open one: it is also the create target. */
export function focusForSelection(path: string): FocusEntry {
  return { path, type: 'file' };
}

/** Does this row carry the active selector? Files and folders alike: the row
 *  you clicked (or the file the editor is showing) is the selected one. */
export function isSelectedRow(selected: string | null, path: string): boolean {
  return !!selected && selected === path;
}
