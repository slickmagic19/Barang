// Shared search-and-replace confirm + apply flow (palette quick-replace and
// the Search view). Dry-run first for exact counts, explicit confirm (there
// is no undo), then apply + resync. Returns whether anything was replaced.
import { fsApi } from './api';
import { editorStore, checkExternalChanges } from '../ui/editor';
import { confirmDialog } from '../ui/dialog';

export interface ReplaceDeps {
  toast(msg: string, kind?: 'info' | 'error'): void;
  refreshExplorer(): void;
}

export interface ReplaceOpts {
  q: string;
  replacement: string;
  regex: boolean;
  wholeWord: boolean;
  caseSensitive: boolean;
  include?: string[];
  exclude?: string[];
  onlyFiles?: string[];
  scopeLabel?: string; // e.g. 'in src/foo.ts' — appended to the confirm title
}

export async function confirmAndApplyReplace(
  deps: ReplaceDeps,
  opts: ReplaceOpts,
  onApplied?: () => void,
): Promise<{ replaced: boolean; totalMatches: number; totalFiles: number }> {
  const none = { replaced: false, totalMatches: 0, totalFiles: 0 };
  const base = {
    q: opts.q, replacement: opts.replacement, regex: opts.regex, wholeWord: opts.wholeWord,
    caseSensitive: opts.caseSensitive, include: opts.include, exclude: opts.exclude,
    onlyFiles: opts.onlyFiles,
  };
  let dry;
  try {
    dry = await fsApi.searchReplace({ ...base, dryRun: true });
  } catch (e) {
    deps.toast(`Replace failed: ${(e as Error).message}`, 'error');
    return none;
  }
  if (!dry.totalFiles) {
    deps.toast('No matches found.', 'info');
    return none;
  }
  const dirtyHit = editorStore.get().tabs.filter(
    (t) => t.dirty && dry.files.some((f) => f.path === (t.file ?? t.path)),
  ).length;
  const extra = dry.totalFiles > dry.files.length ? ` (showing first ${dry.files.length})` : '';
  const skipped = dry.skippedCount ? ` Skipped ${dry.skippedCount} binary/large file(s).` : '';
  const ok = await confirmDialog({
    title: opts.scopeLabel ? `Replace all ${opts.scopeLabel}?` : 'Replace all?',
    message: `Replace ${dry.totalMatches} match(es) in ${dry.totalFiles} file(s)${extra} with "${opts.replacement.slice(0, 80)}"?${skipped} This cannot be undone.${dirtyHit ? ` ${dirtyHit} open unsaved tab(s) keep their edits — review them after.` : ''}`,
    confirmLabel: `Replace ${dry.totalMatches}`,
    danger: true,
  });
  if (!ok) return none;
  try {
    const done = await fsApi.searchReplace({ ...base, dryRun: false });
    deps.toast(`Replaced ${done.totalMatches} match(es) in ${done.totalFiles} file(s).`, 'info');
    deps.refreshExplorer();
    await checkExternalChanges().catch(() => {});
    onApplied?.();
    return { replaced: true, totalMatches: done.totalMatches, totalFiles: done.totalFiles };
  } catch (e) {
    deps.toast(`Replace failed: ${(e as Error).message}`, 'error');
    return none;
  }
}
