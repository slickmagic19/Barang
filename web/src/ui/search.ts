// Sidebar Search view (VSCode parity): project find + replace with match
// toggles (case / whole word / regex), include/exclude scope, file-grouped
// results with highlighted previews, per-file + global replace (confirm +
// no-undo, shared with the palette flow), collapse, history-free refresh.
import { fsApi } from '../lib/api';
import { el, debounce } from '../lib/util';
import { iconEl } from './icons';
import { fileIconEl } from './fileIcons';
import { confirmAndApplyReplace } from '../lib/replaceFlow';

export interface SearchHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  revealInEditor(path: string, line?: number): void;
  revealSearchMatch(path: string, line: number | undefined, query: string, flags: { regex: boolean; caseSensitive: boolean }): void;
  refreshExplorer(): void;
}

interface SearchDetail { path: string; line: number; text: string; cols: number[] }
interface SearchState {
  totalMatches: number;
  totalFiles: number;
  files: Array<{ path: string; matches: number }>;
  details: SearchDetail[];
  detailTruncated: boolean;
  candidateTruncated: boolean;
  scannedFiles: number;
  skippedCount: number;
}

const LS_PREFS = 'barang:search-view-prefs';

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    return {
      regex: p.regex === true,
      wholeWord: p.wholeWord === true,
      caseSensitive: p.caseSensitive !== false,
      optionsOpen: p.optionsOpen === true,
    };
  } catch {
    return { regex: false, wholeWord: false, caseSensitive: true, optionsOpen: false };
  }
}

/** Render a preview line with [start, len] match pairs highlighted. */
export function highlightLine(text: string, cols: number[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!cols.length) return esc(text);
  let out = '';
  let at = 0;
  for (let i = 0; i + 1 < cols.length; i += 2) {
    const s = Math.max(0, Math.min(text.length, cols[i]));
    const e = Math.max(s, Math.min(text.length, s + Math.max(0, cols[i + 1])));
    if (s < at) continue; // overlapping — keep first
    out += esc(text.slice(at, s)) + `<mark>${esc(text.slice(s, e))}</mark>`;
    at = e;
  }
  return out + esc(text.slice(at));
}

export function initSearchView(host: HTMLElement, hooks: SearchHooks) {
  const prefs = loadPrefs();
  const savePrefs = () => {
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify({
        regex, wholeWord, caseSensitive, optionsOpen,
      }));
    } catch {
      /* noop */
    }
  };
  let regex = prefs.regex;
  let wholeWord = prefs.wholeWord;
  let caseSensitive = prefs.caseSensitive;
  let optionsOpen = prefs.optionsOpen;

  let st: SearchState | null = null;
  let searching = false;
  let searchSeq = 0; // stale slow scans never paint over fresher ones
  const collapsed = new Set<string>();
  const dismissed = new Set<string>();

  host.classList.add('search-view');
  const head = el('div', { class: 'search-title' });
  head.append(el('span', { class: 'search-title-text' }, 'SEARCH'));
  const headActs = el('div', { class: 'scm-sync' });
  const mkHead = (icon: 'refresh' | 'x' | 'chevD', title: string, run: () => void, cls = '') => {
    const b = el('button', { class: `icon-btn ${cls}`.trim(), title }) as HTMLButtonElement;
    b.append(iconEl(icon, 13));
    b.onclick = run;
    headActs.append(b);
    return b;
  };
  const btnCollapse = mkHead('chevD', 'Collapse all', () => {
    if (!st) return;
    for (const f of st.files) collapsed.add(f.path);
    paintResults();
  });
  const btnRefresh = mkHead('refresh', 'Refresh search', () => void runSearch(true));
  const btnClear = mkHead('x', 'Clear search', () => {
    queryInput.value = '';
    replaceInput.value = '';
    st = null;
    dismissed.clear();
    collapsed.clear();
    paintResults();
    queryInput.focus();
  });
  void btnCollapse; void btnRefresh; void btnClear;
  head.append(headActs);

  const form = el('div', { class: 'search-form' });
  // Replace input is always visible (no toggle to lose it behind).
  const repRow = el('div', { class: 'search-row' });
  const replaceInput = el('input', { class: 'search-input', placeholder: 'Replace with… ($1 groups in regex mode)', 'aria-label': 'Replace with' }) as HTMLInputElement;
  repRow.append(replaceInput);
  const qRow = el('div', { class: 'search-row' });
  const queryInput = el('input', { class: 'search-input', placeholder: 'Search files ({{vars}} not supported here)', 'aria-label': 'Search files' }) as HTMLInputElement;
  const tglCase = el('button', { class: 'palette-toggle', title: 'Match case' }, 'Aa') as HTMLButtonElement;
  const tglWord = el('button', { class: 'palette-toggle', title: 'Match whole word' }, 'ab') as HTMLButtonElement;
  const tglRegex = el('button', { class: 'palette-toggle', title: 'Use regular expression' }, '.*') as HTMLButtonElement;
  const paintToggles = () => {
    tglCase.classList.toggle('active', caseSensitive);
    tglWord.classList.toggle('active', wholeWord);
    tglRegex.classList.toggle('active', regex);
  };
  tglCase.onclick = () => {
    caseSensitive = !caseSensitive;
    paintToggles();
    savePrefs();
    void runSearch(true);
  };
  tglWord.onclick = () => {
    wholeWord = !wholeWord;
    paintToggles();
    savePrefs();
    void runSearch(true);
  };
  tglRegex.onclick = () => {
    regex = !regex;
    paintToggles();
    savePrefs();
    void runSearch(true);
  };
  const btnOpts = el('button', { class: 'icon-btn', title: 'Toggle include/exclude scope' }) as HTMLButtonElement;
  btnOpts.append(iconEl('meatball', 15));
  qRow.append(queryInput, tglCase, tglWord, tglRegex, btnOpts);
  paintToggles();

  const optsBox = el('div', { class: 'search-opts hidden' });
  const includeInput = el('input', { class: 'search-input', placeholder: 'files to include (a/b, comma-separated)' }) as HTMLInputElement;
  const excludeInput = el('input', { class: 'search-input', placeholder: 'files to exclude (substring, comma-separated)' }) as HTMLInputElement;
  optsBox.append(includeInput, excludeInput);
  const paintOpts = () => optsBox.classList.toggle('hidden', !optionsOpen);
  btnOpts.onclick = () => {
    optionsOpen = !optionsOpen;
    paintOpts();
    savePrefs();
  };
  paintOpts();

  const resultsHead = el('div', { class: 'search-results-head hidden' });
  const resultsCount = el('span', { class: 'search-count' });
  const btnReplaceAll = el('button', { class: 'btn btn-sm', title: 'Replace all matches (confirms first)' }, 'Replace All') as HTMLButtonElement;
  btnReplaceAll.onclick = () => void replaceAllFlow();
  resultsHead.append(resultsCount, btnReplaceAll);
  const results = el('div', { class: 'search-results' });
  host.append(head, form, resultsHead, results);
  form.append(qRow, repRow, optsBox);

  const splitList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const opts = () => ({
    q: queryInput.value,
    replacement: replaceInput.value,
    regex, wholeWord, caseSensitive,
    include: splitList(includeInput.value),
    exclude: splitList(excludeInput.value),
  });

  async function runSearch(immediate: boolean): Promise<void> {
    const q = queryInput.value.trim();
    if (!q) {
      st = null;
      dismissed.clear();
      paintResults();
      return;
    }
    void immediate; // reserved: force vs debounced callers share this path
    const my = ++searchSeq;
    searching = true;
    paintResults();
    try {
      const o = opts();
      const r = await fsApi.searchReplace({ ...o, dryRun: true });
      if (my !== searchSeq) return; // superseded
      st = {
        totalMatches: r.totalMatches, totalFiles: r.totalFiles, files: r.files,
        details: r.details ?? [], detailTruncated: !!r.detailTruncated,
        candidateTruncated: !!r.candidateTruncated, scannedFiles: r.scannedFiles ?? 0,
        skippedCount: r.skippedCount ?? 0,
      };
    } catch (e) {
      if (my !== searchSeq) return;
      st = null;
      hooks.toast(`Search failed: ${(e as Error).message}`, 'error');
    } finally {
      if (my === searchSeq) {
        searching = false;
        paintResults();
      }
    }
  }
  const runDebounced = debounce(() => void runSearch(false), 400);
  queryInput.oninput = () => void runDebounced();
  queryInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runSearch(true);
    }
  };
  includeInput.oninput = () => void runDebounced();
  excludeInput.oninput = () => void runDebounced();

  async function replaceAllFlow() {
    const o = opts();
    if (!o.q.trim()) {
      hooks.toast('Type something to find first.', 'info');
      return;
    }
    const r = await confirmAndApplyReplace(hooks, o, () => void runSearch(true));
    void r;
  }

  async function replaceFile(path: string) {
    const o = opts();
    await confirmAndApplyReplace(
      hooks,
      { ...o, onlyFiles: [path], scopeLabel: `in ${path}` },
      () => void runSearch(true),
    );
  }

  function paintResults() {
    resultsHead.classList.toggle('hidden', !st && !searching);
    resultsHead.classList.toggle('hidden', !st && !searching);
    results.innerHTML = '';
    if (searching && !st) {
      results.append(el('div', { class: 'scm-none' }, 'Searching…'));
      resultsCount.textContent = '';
      return;
    }
    if (!st) {
      results.append(el('div', { class: 'scm-empty' },
        el('div', { class: 'scm-empty-title' }, 'Search this project'),
        el('div', { class: 'scm-empty-sub' }, 'Find text, preview matches, replace with confirm. Nothing is written without asking.'),
      ));
      resultsCount.textContent = '';
      return;
    }
    const shownFiles = st.files.filter((f) => !dismissed.has(f.path));
    resultsCount.textContent = searching
      ? 'Searching…'
      : `${st.totalMatches} result${st.totalMatches === 1 ? '' : 's'} in ${st.totalFiles} file${st.totalFiles === 1 ? '' : 's'}`;
    if (st.candidateTruncated || st.detailTruncated || st.skippedCount) {
      const notes: string[] = [];
      if (st.candidateTruncated) notes.push('file list capped');
      if (st.detailTruncated) notes.push('previews capped');
      if (st.skippedCount) notes.push(`skipped ${st.skippedCount} binary/large`);
      resultsCount.textContent += ` (${notes.join(', ')})`;
    }
    btnReplaceAll.classList.toggle('hidden', !st.totalFiles);
    const byFile = new Map<string, typeof st.details>();
    for (const d of st.details) {
      if (!byFile.has(d.path)) byFile.set(d.path, []);
      byFile.get(d.path)!.push(d);
    }
    if (!shownFiles.length) {
      results.append(el('div', { class: 'scm-none' }, dismissed.size ? 'All results dismissed — run a new search to reset.' : 'No matches.'));
      return;
    }
    for (const f of shownFiles) {
      const isCollapsed = collapsed.has(f.path);
      const sec = el('div', { class: 'search-file' });
      const h = el('div', { class: 'scm-sec-head search-file-head' });
      const tw = el('span', { class: `tw${isCollapsed ? '' : ' open'}` });
      tw.append(iconEl('chevR', 12));
      h.append(tw);
      const nm = el('button', { class: 'search-file-name' }) as HTMLButtonElement;
      nm.append(fileIconEl(f.path.split('/').pop() ?? f.path, 14), el('span', {}, f.path));
      nm.title = `${f.path} — click to open`;
      nm.onclick = () => hooks.revealSearchMatch(f.path, byFile.get(f.path)?.[0]?.line, queryInput.value, { regex, caseSensitive });
      const cnt = el('span', { class: 'scm-count' }, String(f.matches));
      const tools = el('div', { class: 'scm-sec-tools' });
      const bRep = el('button', { class: 'icon-btn', title: `Replace all in ${f.path} (confirms first)` }) as HTMLButtonElement;
      bRep.append(iconEl('pencil', 13));
      bRep.onclick = (e) => {
        e.stopPropagation();
        void replaceFile(f.path);
      };
      const bDis = el('button', { class: 'icon-btn', title: 'Dismiss from results' }) as HTMLButtonElement;
      bDis.append(iconEl('x', 13));
      bDis.onclick = (e) => {
        e.stopPropagation();
        dismissed.add(f.path);
        paintResults();
      };
      tools.append(bRep, bDis);
      h.append(nm, cnt, tools);
      h.onclick = () => {
        if (collapsed.has(f.path)) collapsed.delete(f.path);
        else collapsed.add(f.path);
        paintResults();
      };
      sec.append(h);
      if (!isCollapsed) {
        const dets = byFile.get(f.path) ?? [];
        if (!dets.length) {
          sec.append(el('div', { class: 'scm-none' }, `${f.matches} match(es) — preview capped, open the file to review.`));
        }
        for (const d of dets) {
          const row = el('button', { class: 'scm-row search-match' }) as HTMLButtonElement;
          row.append(el('span', { class: 'search-line' }, String(d.line)));
          const prev = el('span', { class: 'search-preview' });
          prev.innerHTML = highlightLine(d.text, d.cols ?? []);
          row.append(prev);
          row.title = `${f.path}:${d.line} — click to open`;
          row.onclick = () => hooks.revealSearchMatch(f.path, d.line, queryInput.value, { regex, caseSensitive });
          sec.append(row);
        }
      }
      results.append(sec);
    }
  }

  return {
    focus(selectAll = true) {
      if (selectAll) queryInput.select();
      queryInput.focus();
    },
    refresh() {
      void runSearch(true);
    },
    /** Explorer "Search in Folder": scope + focus. */
    setScope(folder: string) {
      includeInput.value = folder;
      optionsOpen = true;
      paintOpts();
      savePrefs();
      this.focus(false);
      void runSearch(true);
    },
  };
}

export type SearchApi = ReturnType<typeof initSearchView>;
