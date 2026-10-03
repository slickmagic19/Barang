// Tabs + Monaco editor. Monaco loads lazily on first file open so the app
// shell paints instantly; models are cached per tab and disposed on close.
import * as monacoLoader from './monaco';
import { fsApi } from '../lib/api';
import { agentStore, readSettings } from '../lib/agent';
import { createStore } from '../lib/util';
import { confirmDialog } from './dialog';

export interface Tab {
  path: string; // unique tab id (file path, `diff:<file>`, or `untitled:<n>`)
  file?: string; // real workspace file (== path for normal tabs)
  title?: string; // display label override (untitled tabs)
  untitled?: boolean; // unsaved scratch tab (VSCode Ctrl+N model)
  dirty: boolean;
  mtime?: number;
  diff?: { before: string; after: string }; // present on session-diff review tabs
  diffKind?: 'git' | 'session'; // diff provenance (git tabs get range-staging)
}

interface EditorState {
  tabs: Tab[];
  active: string | null;
}

export const editorStore = createStore<EditorState>({ tabs: [], active: null });

type Monaco = typeof import('monaco-editor');
let monaco: Monaco | null = null;
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
let diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null;
let editorDiv: HTMLElement | null = null;
let diffDiv: HTMLElement | null = null;
const models = new Map<string, import('monaco-editor').editor.ITextModel>();
const diffModels = new Map<string, { original: import('monaco-editor').editor.ITextModel; modified: import('monaco-editor').editor.ITextModel }>();
let suppressDirty = false;

export interface EditorHooks {
  onCursor(pos: { line: number; col: number }): void;
  onTabs(): void;
  toast(msg: string, kind?: 'info' | 'error'): void;
}
let hooks: EditorHooks | null = null;

function nameOf(path: string): string {
  return path.split('/').pop() || path;
}

/** True when any line exceeds ~200KB (minified bundles): tokenizing those
 *  freezes highlight. Early-exit scan, no full split. */
function hasMonsterLine(content: string): boolean {
  let prev = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      if (i - prev > 200000) return true;
      prev = i + 1;
    }
  }
  return content.length - prev > 200000;
}

/** Monaco language id for a path. tsx/jsx MUST be the *react variants —
 *  plain typescript/javascript plus default compiler options is exactly the
 *  "Cannot use JSX unless the '--jsx' flag is provided" (17004) swamp. */
export function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascriptreact',
    json: 'json', html: 'html', css: 'css',
    scss: 'scss', less: 'less', md: 'markdown', py: 'python', rs: 'rust',
    go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    toml: 'ini', xml: 'xml', sql: 'sql', vue: 'html', svelte: 'html',
  };
  return map[ext] ?? 'plaintext';
}

/** The TS compiler options applied to Monaco (set in initEditor). Exposed
 *  for the smoke probe — the app must never run with jsx: None. */
let appliedTsOptions: Record<string, unknown> | null = null;
export function getTsDiagOptions(): Record<string, unknown> | null {
  return appliedTsOptions;
}

/** TypeScript engine setup: modern JSX + Node-style resolution. Without
 *  jsx: ReactJSX every .tsx file drowns in 17004s even though vite/esbuild
 *  compiles it fine. Kept lenient (strict off): without the project's full
 *  type environment, strict flags working code. */
function configureTsDiagnostics() {
  if (!monaco || appliedTsOptions) return;
  const ts = monaco.languages.typescript;
  const opts = {
    ...ts.typescriptDefaults.getCompilerOptions(),
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
  };
  ts.typescriptDefaults.setCompilerOptions(opts);
  ts.javascriptDefaults.setCompilerOptions({ ...opts });
  appliedTsOptions = { ...opts };
}

// Project type packages surfaced to Monaco (the editor has no node_modules
// access of its own). @types/react (+ react-dom) is what kills the follow-on
// "cannot find module / JSX runtime" noise in Vite react-ts projects.
let typesForRoot = '';
let typeDisposables: Array<{ dispose(): void }> = [];
const TYPE_CANDIDATES = [
  'node_modules/@types/react/index.d.ts',
  'node_modules/@types/react-dom/index.d.ts',
];

async function ensureProjectTypes() {
  if (!monaco) return;
  const root = agentStore.get().root || '';
  if (!root || root === typesForRoot) return;
  typesForRoot = root;
  for (const d of typeDisposables) {
    try { d.dispose(); } catch { /* noop */ }
  }
  typeDisposables = [];
  for (const rel of TYPE_CANDIDATES) {
    try {
      const f = await fsApi.read(rel);
      const content = f.content ?? '';
      if (!content || content.length > 1024 * 1024 || f.binary) continue;
      typeDisposables.push(
        monaco.languages.typescript.typescriptDefaults.addExtraLib(content, `file:///node_modules/${rel}`),
      );
    } catch { /* package absent — the compiler-option fix still stands */ }
  }
}
/** Apply persisted editor prefs (font size, minimap) to the live editor. */
export function applyEditorPrefs() {
  if (!editor) return;
  const s = readSettings();
  editor.updateOptions({ fontSize: s.fontSize, minimap: { enabled: s.minimap }, wordWrap: s.wordWrap ? 'on' : 'off' });
}

export async function initEditor(container: HTMLElement, h: EditorHooks) {
  hooks = h;
  monaco = await monacoLoader.load();
  configureTsDiagnostics();
  const prefs = readSettings();
  editorDiv = document.createElement('div');
  editorDiv.className = 'editor-pane';
  diffDiv = document.createElement('div');
  diffDiv.className = 'editor-pane hidden';
  container.append(editorDiv, diffDiv);
  editor = monaco.editor.create(editorDiv, {
    theme: 'barang-dark',
    automaticLayout: true,
    fontFamily: "'JetBrains Mono','Cascadia Code',Consolas,monospace",
    fontSize: prefs.fontSize,
    lineHeight: 1.55,
    minimap: { enabled: prefs.minimap },
    wordWrap: prefs.wordWrap ? 'on' : 'off',
    // Slim overlay-style scrollbars (the 14px default dominates the edge).
    scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    renderLineHighlight: 'all',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    tabSize: 2,
  });
  monaco.editor.defineTheme('barang-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'comment', foreground: '63636b' }],
    colors: {
      'editor.background': '#080808',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorLineNumber.foreground': '#52525b',
      'editorLineNumber.activeForeground': '#d4d4d8',
      'editorCursor.foreground': '#fafafa',
      'editor.selectionBackground': '#ffffff26',
      'editorWidget.background': '#101012',
      'editorWidget.border': '#ffffff1f',
    },
  });
  monaco.editor.setTheme('barang-dark');
  editor.onDidChangeModelContent(() => {
    if (suppressDirty || !editor) return;
    const path = editorStore.get().active;
    if (!path) return;
    editorStore.set((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, dirty: true } : t)),
    }));
    hooks?.onTabs();
  });
  editor.onDidChangeCursorPosition((e) => hooks?.onCursor({ line: e.position.lineNumber, col: e.position.column }));
}

export async function openFile(path: string, opts?: { focus?: boolean }) {
  if (!editor || !monaco) return;
  const wantFocus = opts?.focus ?? true;
  let tab = editorStore.get().tabs.find((t) => t.path === path);
  if (!tab) {
    tab = { path, file: path, dirty: false };
    editorStore.set((s) => ({ tabs: [...s.tabs, tab!], active: path }));
  } else {
    editorStore.set({ active: path });
  }
  let model = models.get(path);
  if (!model) {
    try {
      const file = await fsApi.read(path);
      if (file.binary) {
        hooks?.toast(`${path} is binary — preview not supported`, 'error');
        editorStore.set((s) => ({ ...s, tabs: s.tabs.filter((t) => t.path !== path), active: s.tabs.find((t) => t.path !== path)?.path ?? null }));
        hooks?.onTabs();
        return;
      }
      tab.mtime = file.mtime;
      // Minified/bundled single-line monsters freeze syntax highlighting:
      // open them as plain text (still fully editable) with a one-time note.
      const content = file.content ?? '';
      let lang = langOf(path);
      if (lang !== 'plaintext' && hasMonsterLine(content)) {
        lang = 'plaintext';
        hooks?.toast(`${nameOf(path)} has very long lines — syntax highlighting off for speed.`, 'info');
      }
      model = monaco.editor.createModel(content, lang, monaco.Uri.parse(`inmemory://barang/${path}`));
      model.onDidChangeContent(() => {});
      models.set(path, model);
      // First TS model per project: surface the project's own @types/react
      // so module + JSX-runtime errors resolve like the real tsc would.
      if (lang === 'typescriptreact' || lang === 'typescript') {
        void ensureProjectTypes().catch(() => {});
      }
    } catch (e) {
      hooks?.toast(`Cannot open ${path}: ${(e as Error).message}`, 'error');
      editorStore.set((s) => ({ ...s, tabs: s.tabs.filter((t) => t.path !== path), active: s.active === path ? (s.tabs.find((t) => t.path !== path)?.path ?? null) : s.active }));
      hooks?.onTabs();
      return;
    }
  }
  suppressDirty = true;
  showNormal();
  editor.setModel(model);
  suppressDirty = false;
  hooks?.onTabs();
  if (wantFocus) editor.focus();
}

/** Show the normal editor pane (hide the diff pane). */
function showNormal() {
  diffDiv?.classList.add('hidden');
  editorDiv?.classList.remove('hidden');
}

/** Show the diff pane (hide the normal editor), re-laying out after unhide. */
function showDiff() {
  editorDiv?.classList.add('hidden');
  diffDiv?.classList.remove('hidden');
  if (diffEditor) requestAnimationFrame(() => diffEditor!.layout());
}

function ensureDiffEditor() {
  if (diffEditor || !monaco || !diffDiv) return diffEditor;
  const prefs = readSettings();
  diffEditor = monaco.editor.createDiffEditor(diffDiv, {
    theme: 'barang-dark',
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    scrollBeyondLastLine: false,
    fontFamily: "'JetBrains Mono','Cascadia Code',Consolas,monospace",
    fontSize: prefs.fontSize,
    lineHeight: 1.55,
    minimap: { enabled: false },
    scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    renderLineHighlight: 'all',
    smoothScrolling: true,
  });
  // VSCode "Stage Selected Ranges": right-click in a git file diff stages
  // the selected modified-side lines. Session diffs are not stageable.
  diffEditor.getModifiedEditor().addAction({
    id: 'barang.git.stageRanges',
    label: 'Git: Stage Selected Ranges',
    contextMenuGroupId: 'modification',
    contextMenuOrder: 1.5,
    run: (ed) => {
      const s = editorStore.get();
      const tab = s.tabs.find((t) => t.path === s.active);
      if (!tab?.diff || tab.diffKind !== 'git' || !tab.file) {
        hooks?.toast('Stage Selected Ranges needs a git file diff with a selection.', 'info');
        return;
      }
      const sel = ed.getSelection();
      if (!sel || sel.isEmpty()) {
        hooks?.toast('Select changed lines in the right (modified) pane first.', 'info');
        return;
      }
      stageRangesHandler?.({ file: tab.file, start: sel.startLineNumber, end: sel.endLineNumber });
    },
  });
  return diffEditor;
}

let stageRangesHandler: ((sel: { file: string; start: number; end: number }) => void) | null = null;

/** SCM registers the backend for the diff-editor range-staging action. */
export function registerStageRangesAction(handler: (sel: { file: string; start: number; end: number }) => void) {
  stageRangesHandler = handler;
}

/**
 * Open a session-diff review tab (read-only before/after from opencode).
 * Reuses the tab + models when already open, refreshing contents.
 * Loads Monaco on demand: a diff can be the very first thing opened.
 */
export async function openDiffTab(file: string, before: string, after: string, kind: 'git' | 'session' = 'session') {
  if (!monaco) {
    try {
      monaco = await monacoLoader.load();
    } catch (e) {
      hooks?.toast(`Cannot open diff: ${(e as Error).message}`, 'error');
      return;
    }
  }
  if (!ensureDiffEditor()) return;
  const path = `diff:${file}`;
  const tab = editorStore.get().tabs.find((t) => t.path === path);
  if (!tab) {
    editorStore.set((s) => ({ tabs: [...s.tabs, { path, file, dirty: false, diff: { before, after }, diffKind: kind }], active: path }));
  } else {
    tab.diff = { before, after };
    tab.diffKind = kind;
    editorStore.set({ active: path });
  }
  diffModels.get(path)?.original.dispose();
  diffModels.get(path)?.modified.dispose();
  const original = monaco.editor.createModel(before, langOf(file));
  const modified = monaco.editor.createModel(after, langOf(file));
  diffModels.set(path, { original, modified });
  diffEditor!.setModel({ original, modified });
  showDiff();
  hooks?.onTabs();
}

/** Activate an already-open diff tab (models cached on the tab). */
export function showDiffTab(path: string) {
  const pair = diffModels.get(path);
  if (!ensureDiffEditor() || !pair) return;
  editorStore.set({ active: path });
  diffEditor!.setModel({ original: pair.original, modified: pair.modified });
  showDiff();
  hooks?.onTabs();
}

export async function closeTab(path: string) {
  const s = editorStore.get();
  const tab = s.tabs.find((t) => t.path === path);
  if (tab?.dirty) {
    const name = tab.title ?? path.split('/').pop() ?? path;
    const ok = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: `${name} has unsaved changes that will be lost.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
  }
  dropTabs([path]);
}

/** Remove tabs without asking (callers confirm first). Shared by all batch closes. */
function dropTabs(paths: string[]) {
  if (!paths.length) return;
  const gone = new Set(paths);
  for (const p of paths) {
    models.get(p)?.dispose();
    models.delete(p);
    const pair = diffModels.get(p);
    if (pair) {
      pair.original.dispose();
      pair.modified.dispose();
      diffModels.delete(p);
    }
  }
  const s = editorStore.get();
  const rest = s.tabs.filter((t) => !gone.has(t.path));
  const active = s.active && !gone.has(s.active) ? s.active : (rest[rest.length - 1]?.path ?? null);
  editorStore.set({ tabs: rest, active });
  const activeTab = rest.find((t) => t.path === active);
  const pair = active ? diffModels.get(active) : undefined;
  if (editor && monaco) {
    if (activeTab?.diff && pair && diffEditor) {
      diffEditor.setModel({ original: pair.original, modified: pair.modified });
      showDiff();
    } else {
      showNormal();
      editor.setModel(active ? (models.get(active) ?? null) : null);
    }
  }
  hooks?.onTabs();
}

function dirtyAmong(paths: string[]) {
  const set = new Set(paths);
  return editorStore.get().tabs.filter((t) => set.has(t.path) && t.dirty);
}

/** One confirm for a batch (VSCode-style) instead of per-tab prompts. */
async function confirmDiscard(paths: string[]): Promise<boolean> {
  const dirty = dirtyAmong(paths);
  if (!dirty.length) return true;
  const names = dirty.slice(0, 4).map((t) => t.title ?? t.path.split('/').pop()).join(', ') +
    (dirty.length > 4 ? `, +${dirty.length - 4} more` : '');
  return confirmDialog({
    title: 'Discard unsaved changes?',
    message: `${dirty.length} file(s) have unsaved changes that will be lost: ${names}.`,
    confirmLabel: 'Discard',
    danger: true,
  });
}

export async function closeOtherTabs(keep: string) {
  const others = editorStore.get().tabs.map((t) => t.path).filter((p) => p !== keep);
  if (!(await confirmDiscard(others))) return;
  dropTabs(others);
}

export async function closeAllTabs(): Promise<boolean> {
  const all = editorStore.get().tabs.map((t) => t.path);
  if (!(await confirmDiscard(all))) return false;
  dropTabs(all);
  return true;
}

export function closeSavedTabs() {
  dropTabs(editorStore.get().tabs.filter((t) => !t.dirty).map((t) => t.path));
}

/** Close a tab and any tabs under it (deleted/renamed folder). False = user cancelled. */
export async function closePathAndChildren(prefix: string): Promise<boolean> {
  const hit = editorStore.get().tabs
    .map((t) => t.path)
    .filter((p) => p === prefix || p.startsWith(prefix + '/') || p === `diff:${prefix}` || p.startsWith(`diff:${prefix}/`));
  if (!hit.length) return true;
  if (!(await confirmDiscard(hit))) return false;
  dropTabs(hit);
  return true;
}

export async function saveActive(): Promise<boolean> {
  const { active } = editorStore.get();
  if (!active || !editor) return false;
  const tab = editorStore.get().tabs.find((t) => t.path === active);
  if (tab?.untitled) return saveUntitledAs(tab);
  const model = models.get(active);
  if (!model) return false;
  try {
    const res = await fsApi.write(active, model.getValue());
    editorStore.set((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === active ? { ...t, dirty: false, mtime: res.mtime } : t)),
    }));
    hooks?.onTabs();
    return true;
  } catch (e) {
    hooks?.toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Untitled Save-As: native dialog, then adopt the path (or close + note
 *  when saved outside the project, where the workspace cannot track it). */
async function saveUntitledAs(tab: Tab): Promise<boolean> {
  const model = models.get(tab.path);
  if (!model) return false;
  let picked: { path: string };
  try {
    picked = await awaitSaveDialog();
  } catch (e) {
    if (!/cancelled/i.test((e as Error).message)) hooks?.toast((e as Error).message, 'error');
    return false;
  }
  const content = model.getValue();
  try {
    const res = await fsApi.writeAbsolute(picked.path, content);
    dropTabs([tab.path]);
    if (res.rootRel) {
      await openFile(res.rootRel);
      hooks?.toast(`Saved ${res.rootRel}.`, 'info');
    } else {
      hooks?.toast(`Saved outside the project: ${res.path}. Open its folder to keep editing it.`, 'info');
    }
    return true;
  } catch (e) {
    hooks?.toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

async function awaitSaveDialog(): Promise<{ path: string }> {
  const { barang } = await import('../lib/transport');
  return barang().app.saveDialog();
}

let untitledSeq = 0;

/** New untitled scratch tab (VSCode Ctrl+N). No disk footprint until saved. */
export function openUntitled() {
  if (!editor || !monaco) return;
  untitledSeq++;
  let n = untitledSeq;
  while (editorStore.get().tabs.some((t) => t.path === `untitled:${n}`)) n++;
  untitledSeq = n;
  const path = `untitled:${n}`;
  const model = monaco.editor.createModel('', 'plaintext', monaco.Uri.parse(`inmemory://barang/${path}`));
  models.set(path, model);
  editorStore.set((s) => ({
    tabs: [...s.tabs, { path, title: `Untitled-${n}`, untitled: true, dirty: false }],
    active: path,
  }));
  showNormal();
  suppressDirty = true;
  editor.setModel(model);
  suppressDirty = false;
  hooks?.onTabs();
  editor.focus();
}

export async function saveAll() {
  const tabs = editorStore.get().tabs.filter((t) => t.dirty);
  const skipped = tabs.filter((t) => t.untitled);
  for (const t of tabs) {
    if (t.untitled) continue; // untitled needs its own Save-As dialog (Ctrl+S)
    const m = models.get(t.path);
    if (!m) continue;
    try {
      const res = await fsApi.write(t.path, m.getValue());
      t.dirty = false;
      t.mtime = res.mtime;
    } catch (e) {
      hooks?.toast(`Save failed (${t.path}): ${(e as Error).message}`, 'error');
    }
  }
  if (skipped.length) hooks?.toast(`${skipped.length} untitled tab(s) skipped — use Ctrl+S for Save As.`, 'info');
  editorStore.set((s) => ({ ...s }));
  hooks?.onTabs();
}

/** On window focus: reload clean tabs changed on disk (agent edits!), warn on dirty ones. */
export async function checkExternalChanges() {
  const s = editorStore.get();
  for (const t of [...s.tabs]) {
    const model = models.get(t.path);
    if (!model) continue;
    try {
      const file = await fsApi.read(t.path);
      if (file.binary || file.mtime === undefined || file.mtime === t.mtime) continue;
      if (t.dirty) {
        hooks?.toast(`${t.path} changed on disk (agent?) — your unsaved edits kept`, 'info');
        t.mtime = file.mtime;
      } else {
        suppressDirty = true;
        model.setValue(file.content ?? '');
        suppressDirty = false;
        t.mtime = file.mtime;
      }
    } catch { /* file deleted etc. — leave tab as-is */ }
  }
  editorStore.set((st) => ({ ...st }));
  hooks?.onTabs();
}

export function revealInEditor(path: string, line?: number) {
  void openFile(path).then(() => {
    if (line && editor && monaco) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
  });
}
