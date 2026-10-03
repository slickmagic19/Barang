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
  group: 1 | 2; // editor group (VSCode-style split)
}

export type EditorGroup = 1 | 2;

interface EditorState {
  tabs: Tab[];
  active: string | null; // group 1
  active2: string | null; // group 2
  focus: EditorGroup; // group receiving opens/saves/closes
  split: boolean; // second group visible
}

/** Tabs of one group, in order. Pure. */
export function groupTabs(tabs: Tab[], group: EditorGroup): Tab[] {
  return (tabs ?? []).filter((t) => (t.group || 1) === group);
}

export const editorStore = createStore<EditorState>({ tabs: [], active: null, active2: null, focus: 1, split: false });

type Monaco = typeof import('monaco-editor');
let monaco: Monaco | null = null;
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
let editor2: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
let diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null;
let editorDiv: HTMLElement | null = null;
let editorDiv2: HTMLElement | null = null;
let diffDiv: HTMLElement | null = null;
let host1: HTMLElement | null = null;
let host2: HTMLElement | null = null;
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

/** Monaco language id for a path. Deliberately the PLAIN ids (typescript /
 *  javascript), never *react: monaco 0.52 registers no typescriptreact /
 *  javascriptreact Monarch grammar, so those models get zero tokenization
 *  (flat gray, no validation at all). JSX parsing is driven by the TS
 *  worker from the model's file URI (.tsx preserved in inmemory:// URLs)
 *  plus jsx: ReactJSX in the compiler options — that combination kills the
 *  17004 swamp with highlighting intact. */
export function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    tsx: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript',
    json: 'json', html: 'html', css: 'css',
    scss: 'scss', less: 'less', md: 'markdown', py: 'python', rs: 'rust',
    go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    toml: 'ini', xml: 'xml', sql: 'sql', vue: 'html', svelte: 'html',
  };
  return map[ext] ?? 'plaintext';
}

/** Ids Monaco actually tokenizes (Monarch registry). The smoke probe
 *  asserts every langOf() output is in here — an unregistered id renders
 *  flat gray with zero diagnostics, which is how the *react regression
 *  slipped through. */
export function registeredLanguageIds(): string[] {
  try {
    return monaco ? monaco.languages.getLanguages().map((l) => l.id) : [];
  } catch {
    return [];
  }
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

// --- project import map: teach the marker filter what the real toolchain
// resolves (tsconfig paths + installed deps), so only genuinely broken
// imports stay red. Refreshed per project root, alongside the @types load.
export interface ImportMap {
  baseDir: string; // root-relative baseUrl (usually '' or '.')
  aliases: AliasEntry[]; // paths table, e.g. [{ pattern: '@/*', targets: ['./src/*'] }]
  deps: Set<string>; // installed package names
}

let importMapForRoot = '';
let importMap: ImportMap = { baseDir: '', aliases: [], deps: new Set() };

/** Strip JSONC (comments, trailing commas) for tsconfig/package reads. Pure. */
export function parseJsonc(text: string): unknown {
  const noComments = String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
  const noTrailing = noComments.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(noTrailing);
}

/** Pull {baseUrl, entries} from tsconfig text (missing/invalid -> empty). Pure. */
export interface AliasEntry { pattern: string; targets: string[] }
export function parseTsconfigPaths(text: string): { baseUrl: string; entries: AliasEntry[] } {
  try {
    const j = parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
    const co = j?.compilerOptions ?? {};
    const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : '';
    const raw = (co.paths && typeof co.paths === 'object' ? co.paths : {}) as Record<string, unknown>;
    const entries: AliasEntry[] = [];
    for (const [pattern, v] of Object.entries(raw)) {
      if (!pattern) continue;
      const targets = (Array.isArray(v) ? v : [v]).filter((t): t is string => typeof t === 'string' && !!t).slice(0, 5);
      entries.push({ pattern, targets });
      if (entries.length >= 20) break;
    }
    return { baseUrl, entries };
  } catch {
    return { baseUrl: '', entries: [] };
  }
}

/** Match a spec against alias entries ('@/*' matches '@/x').
 *  Returns target heads + remainder. Pure. */
export function matchAlias(spec: string, entries: AliasEntry[]): { targets: string[]; rest: string } | null {
  for (const e of entries ?? []) {
    const p = e.pattern;
    if (!p) continue;
    if (p.endsWith('/*')) {
      const head = p.slice(0, -1); // keep the slash: '@/'
      if (spec.startsWith(head)) return { targets: e.targets, rest: spec.slice(head.length) };
    } else if (spec === p) {
      return { targets: e.targets, rest: '' };
    }
  }
  return null;
}

/** Bare package name of a non-relative spec ('@scope/pkg/sub' -> '@scope/pkg').
 *  Alias specs ('@/x') are NOT packages — null. Pure. */
export function packageNameOf(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec) : parts[0];
}

/** File probes (root-relative) for an import: alias expansion first, then
 *  extension + index variants. Pure — the caller stats them via fs. */
export function candidateImportPaths(fromDir: string, spec: string, map: ImportMap): string[] {
  const norm = (p: string) => {
    const parts = p.replace(/\\/g, '/').split('/');
    const out: string[] = [];
    for (const s of parts) {
      if (!s || s === '.') continue;
      if (s === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else out.push(s);
      } else out.push(s);
    }
    return out.join('/');
  };
  const base = norm(map.baseDir || '.');
  const join = (...segs: string[]) => norm(segs.filter(Boolean).join('/').replace(/\/$/, ''));
  const withVariants = (p: string) => {
    const out = [p];
    if (!/\.[a-z0-9]+$/i.test(p.split('/').pop() ?? '')) {
      out.push(`${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.jsx`, `${p}.d.ts`, `${p}/index.ts`, `${p}/index.tsx`, `${p}/index.js`);
    }
    return out;
  };
  const alias = matchAlias(spec, map.aliases);
  if (alias) {
    // '@/*' -> ['./src/*']: '@/components/X' -> 'src/components/X'.
    const out: string[] = [];
    for (const t of alias.targets.length ? alias.targets : ['./*']) {
      const head = t.endsWith('/*') ? t.slice(0, -1) : t;
      out.push(...withVariants(join(base === '.' ? '' : base, head, alias.rest)));
    }
    return out.slice(0, 24);
  }
  if (spec.startsWith('.')) return withVariants(join(fromDir, spec));
  if (spec.startsWith('/')) return withVariants(spec.slice(1));
  return []; // bare package: resolved via deps set, no file probing
}

async function loadImportMap(): Promise<void> {
  const root = agentStore.get().root || '';
  if (!root || root === importMapForRoot) return;
  importMapForRoot = root;
  const next: ImportMap = { baseDir: '', aliases: [], deps: new Set() };
  for (const f of ['tsconfig.app.json', 'tsconfig.json']) {
    try {
      const t = await fsApi.read(f);
      if (t.binary || !t.content) continue;
      const { baseUrl, entries } = parseTsconfigPaths(t.content);
      if (!next.aliases.length && entries.length) {
        next.aliases = entries;
        next.baseDir = baseUrl;
        break; // app config wins (Vite layout); root is the fallback
      }
    } catch { /* absent */ }
  }
  try {
    const p = await fsApi.read('package.json');
    if (!p.binary && p.content) {
      const j = parseJsonc(p.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> };
      for (const bag of [j.dependencies, j.devDependencies, j.peerDependencies, j.optionalDependencies]) {
        for (const name of Object.keys(bag ?? {})) next.deps.add(name);
      }
    }
  } catch { /* absent */ }
  importMap = next;
}

// --- "Cannot find module" (2307) filter: the worker has no node_modules,
// so every bare/aliased import the real toolchain resolves would stay red.
// Re-resolve each one against the project (tsconfig paths + installed deps
// + relative probing) and hide only the provably-resolvable ones — genuine
// typos and missing files keep their markers.
const TS_OWNERS = ['typescript', 'javascript'];

function isMissingModule(m: { code?: unknown; message?: string }): boolean {
  const code = typeof m.code === 'object' && m.code !== null
    ? String((m.code as { value?: unknown }).value ?? '')
    : String(m.code ?? '');
  return code === '2307' && /cannot find module/i.test(m.message ?? '');
}

function moduleOf(message: string): string | null {
  const m = /cannot find module '([^']+)'/i.exec(String(message ?? ''));
  return m ? m[1] : null;
}

async function probeExists(rel: string): Promise<boolean> {
  try {
    await fsApi.read(rel);
    return true;
  } catch {
    return false;
  }
}

/** Decide one spec against a map + existence probe (injectable for tests).
 *  Aliased + relative specs probe the disk (typos stay red); bare packages
 *  pass when installed. Pure orchestration. */
export async function specResolves(
  spec: string,
  fromDir: string,
  map: ImportMap,
  exists: (rel: string) => Promise<boolean>,
): Promise<boolean> {
  if (!spec) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || matchAlias(spec, map.aliases)) {
    for (const c of candidateImportPaths(fromDir, spec, map)) {
      if (await exists(c)) return true;
    }
    return false;
  }
  const pkg = packageNameOf(spec);
  return !!pkg && map.deps.has(pkg);
}

/** True when the spec resolves the way the project's toolchain would. */
async function resolvesLikeToolchain(spec: string, fromDir: string): Promise<boolean> {
  await loadImportMap();
  return specResolves(spec, fromDir, importMap, probeExists);
}

const markerFilter = {
  timer: null as ReturnType<typeof setTimeout> | null,
  runId: 0,
  lastResolved: new Map<string, string>(), // uri+owner -> signature served
};

function markerSig(markers: Array<{ message?: string; startLineNumber?: number; startColumn?: number; endLineNumber?: number; endColumn?: number; code?: unknown }>): string {
  return JSON.stringify(markers.map((m) => [
    m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn,
    typeof m.code === 'object' && m.code !== null ? (m.code as { value?: unknown }).value : m.code,
    m.message,
  ]));
}

function scheduleMarkerFilter() {
  if (!monaco) return;
  markerFilter.runId++;
  if (markerFilter.timer) clearTimeout(markerFilter.timer);
  markerFilter.timer = setTimeout(() => void runMarkerFilter(markerFilter.runId).catch(() => {}), 400);
}

async function runMarkerFilter(run: number) {
  if (!monaco) return;
  await loadImportMap();
  for (const [path, model] of models) {
    if (run !== markerFilter.runId || model.isDisposed()) {
      if (model.isDisposed()) continue;
      return; // superseded by a newer markers event
    }
    const lang = model.getLanguageId();
    if (lang !== 'typescript' && lang !== 'javascript') continue;
    const fromDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const owner of TS_OWNERS) {
      if (run !== markerFilter.runId) return;
      const key = `${model.uri.toString()}|${owner}`;
      const current = monaco.editor.getModelMarkers({ resource: model.uri, owner });
      if (markerSig(current) === markerFilter.lastResolved.get(key)) continue;
      const cands = current.filter(isMissingModule);
      let kept = current;
      if (cands.length) {
        const drop = new Set<typeof cands[number]>();
        for (const m of cands) {
          if (run !== markerFilter.runId) return;
          const spec = moduleOf(m.message ?? '');
          if (spec && await resolvesLikeToolchain(spec, fromDir)) drop.add(m);
        }
        kept = current.filter((m) => !drop.has(m));
      }
      monaco.editor.setModelMarkers(model, owner, kept);
      markerFilter.lastResolved.set(key, markerSig(kept));
    }
  }
}

let markersWired = false;
function wireMarkerFilter() {
  if (markersWired || !monaco) return;
  markersWired = true;
  monaco.editor.onDidChangeMarkers(() => scheduleMarkerFilter());
}
/** Apply persisted editor prefs (font size, minimap) to both editors. */
export function applyEditorPrefs() {
  const s = readSettings();
  const opts = { fontSize: s.fontSize, minimap: { enabled: s.minimap }, wordWrap: s.wordWrap ? 'on' as const : 'off' as const };
  editor?.updateOptions(opts);
  editor2?.updateOptions(opts);
}

export async function initEditor(container: HTMLElement, h: EditorHooks) {
  hooks = h;
  monaco = await monacoLoader.load();
  configureTsDiagnostics();
  wireMarkerFilter();
  host1 = container;
  const prefs = readSettings();
  editorDiv = document.createElement('div');
  editorDiv.className = 'editor-pane';
  diffDiv = document.createElement('div');
  diffDiv.className = 'editor-pane hidden';
  container.append(editorDiv, diffDiv);
  editor = monaco.editor.create(editorDiv, baseEditorOptions(prefs));
  wireCodeEditor(editor, 1);
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
}

type EditorPrefs = { fontSize: number; minimap: boolean; wordWrap: boolean };

function baseEditorOptions(prefs: EditorPrefs): import('monaco-editor').editor.IStandaloneEditorConstructionOptions {
  return {
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
  };
}

/** Per-editor wiring bound to one group: dirty marks that group's tabs
 *  (shared model → every group showing the path), focus moves the group. */
function wireCodeEditor(ed: import('monaco-editor').editor.IStandaloneCodeEditor, group: EditorGroup) {
  ed.onDidChangeModelContent(() => {
    if (suppressDirty) return;
    const model = ed.getModel();
    if (!model) return;
    const hit = editorStore.get().tabs.some((t) => model === models.get(t.path));
    if (!hit) return;
    editorStore.set((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (models.get(t.path) === model ? { ...t, dirty: true } : t)),
    }));
    hooks?.onTabs();
  });
  ed.onDidChangeCursorPosition((e) => hooks?.onCursor({ line: e.position.lineNumber, col: e.position.column }));
  ed.onDidFocusEditorText(() => {
    if (editorStore.get().focus !== group) editorStore.set({ focus: group });
  });
}

/** Remember the second group's host (main builds it hidden at boot). */
export function setSplitHost(host: HTMLElement) {
  host2 = host;
}

/** Lazily build the group-2 editor inside its host. False when impossible. */
export function ensureSplitEditor(): boolean {
  if (editor2 || !monaco || !host2) return !!editor2;
  const prefs = readSettings();
  editorDiv2 = document.createElement('div');
  editorDiv2.className = 'editor-pane';
  host2.append(editorDiv2);
  editor2 = monaco.editor.create(editorDiv2, baseEditorOptions(prefs));
  wireCodeEditor(editor2, 2);
  const active = editorStore.get().active2;
  if (active) editor2.setModel(models.get(active) ?? null);
  return true;
}

/** Introspection for smoke (and debugging): split state snapshot. */
export function editorSplitState() {
  const s = editorStore.get();
  return {
    split: s.split,
    focus: s.focus,
    hasEditor2: !!editor2,
    hasHost2: !!host2,
    tabs1: groupTabs(s.tabs, 1).length,
    tabs2: groupTabs(s.tabs, 2).length,
  };
}

/** The group receiving opens, saves and closes (1 when unsplit). */
export function focusedGroup(): EditorGroup {
  const s = editorStore.get();
  return s.split && s.focus === 2 ? 2 : 1;
}

function groupActive(s: { active: string | null; active2: string | null }, group: EditorGroup): string | null {
  return group === 2 ? s.active2 : s.active;
}

function editorFor(group: EditorGroup): import('monaco-editor').editor.IStandaloneCodeEditor | null {
  return group === 2 ? editor2 : editor;
}

function setGroupActive(group: EditorGroup, path: string | null) {
  editorStore.set(group === 2 ? { active2: path, focus: 2 } : { active: path, focus: 1 });
}

export async function openFile(path: string, opts?: { focus?: boolean; group?: EditorGroup }) {
  if (!editor || !monaco) return;
  const wantFocus = opts?.focus ?? true;
  const group = opts?.group ?? focusedGroup();
  if (group === 2 && (!editorStore.get().split || !ensureSplitEditor())) {
    // Split unavailable — fall back to group 1 rather than stranding.
    return openFile(path, { focus: wantFocus, group: 1 });
  }
  const ed = editorFor(group);
  if (!ed) return;
  let tab = editorStore.get().tabs.find((t) => t.path === path && (t.group || 1) === group);
  if (!tab) {
    const fresh: Tab = { path, file: path, dirty: false, group };
    editorStore.set((s) => ({ ...s, tabs: [...s.tabs, fresh] }));
    tab = fresh;
  }
  setGroupActive(group, path);
  let model = models.get(path);
  if (!model) {
    try {
      const file = await fsApi.read(path);
      if (file.binary) {
        hooks?.toast(`${path} is binary — preview not supported`, 'error');
        editorStore.set((s) => {
          const rest = s.tabs.filter((t) => !(t.path === path && (t.group || 1) === group));
          const g1 = rest.filter((t) => (t.group || 1) === 1);
          const g2 = rest.filter((t) => (t.group || 1) === 2);
          return {
            ...s,
            tabs: rest,
            active: s.active === path && group === 1 ? (g1[g1.length - 1]?.path ?? null) : s.active,
            active2: s.active2 === path && group === 2 ? (g2[g2.length - 1]?.path ?? null) : s.active2,
          };
        });
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
      if (lang === 'typescript' || lang === 'javascript') {
        void ensureProjectTypes().catch(() => {});
      }
    } catch (e) {
      hooks?.toast(`Cannot open ${path}: ${(e as Error).message}`, 'error');
      editorStore.set((s) => {
        const rest = s.tabs.filter((t) => !(t.path === path && (t.group || 1) === group));
        const g1 = rest.filter((t) => (t.group || 1) === 1);
        const g2 = rest.filter((t) => (t.group || 1) === 2);
        return {
          ...s,
          tabs: rest,
          active: s.active === path && group === 1 ? (g1[g1.length - 1]?.path ?? null) : s.active,
          active2: s.active2 === path && group === 2 ? (g2[g2.length - 1]?.path ?? null) : s.active2,
        };
      });
      hooks?.onTabs();
      return;
    }
  }
  suppressDirty = true;
  showNormal(group);
  ed.setModel(model);
  suppressDirty = false;
  hooks?.onTabs();
  if (wantFocus) ed.focus();
}

/** Show a group's code pane (the diff overlay, if open elsewhere, is left
 *  alone — groups are independent like VSCode). */
function showNormal(group: EditorGroup) {
  diffDiv?.classList.add('hidden');
  (group === 2 ? editorDiv2 : editorDiv)?.classList.remove('hidden');
}

/** Show the diff overlay inside one group's host (the other group keeps
 *  editing behind it — closer to VSCode than a full-center takeover). */
function showDiff(group: EditorGroup) {
  const host = group === 2 ? host2 : host1;
  if (host && diffDiv && diffDiv.parentElement !== host) host.append(diffDiv);
  (group === 2 ? editorDiv2 : editorDiv)?.classList.add('hidden');
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
      const g = focusedGroup();
      const tab = s.tabs.find((t) => t.path === groupActive(s, g) && (t.group || 1) === g);
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
export async function openDiffTab(file: string, before: string, after: string, kind: 'git' | 'session' = 'session', group?: EditorGroup) {
  if (!monaco) {
    try {
      monaco = await monacoLoader.load();
    } catch (e) {
      hooks?.toast(`Cannot open diff: ${(e as Error).message}`, 'error');
      return;
    }
  }
  if (!ensureDiffEditor()) return;
  const g = group ?? focusedGroup();
  if (g === 2 && (!editorStore.get().split || !ensureSplitEditor())) {
    return openDiffTab(file, before, after, kind, 1);
  }
  const path = `diff:${file}`;
  const key = `${g}:${path}`;
  const tab = editorStore.get().tabs.find((t) => t.path === path && (t.group || 1) === g);
  if (!tab) {
    const fresh: Tab = { path, file, dirty: false, diff: { before, after }, diffKind: kind, group: g };
    editorStore.set((s) => ({ ...s, tabs: [...s.tabs, fresh] }));
  } else {
    tab.diff = { before, after };
    tab.diffKind = kind;
  }
  setGroupActive(g, path);
  diffModels.get(key)?.original.dispose();
  diffModels.get(key)?.modified.dispose();
  const original = monaco.editor.createModel(before, langOf(file));
  const modified = monaco.editor.createModel(after, langOf(file));
  diffModels.set(key, { original, modified });
  diffEditor!.setModel({ original, modified });
  showDiff(g);
  hooks?.onTabs();
}

/** Activate an already-open diff tab (models cached on the tab). */
export function showDiffTab(path: string, group?: EditorGroup) {
  const s = editorStore.get();
  const g = group ?? (s.tabs.find((t) => t.path === path && (t.group || 1) === s.focus)?.group as EditorGroup | undefined)
    ?? (s.tabs.find((t) => t.path === path)?.group as EditorGroup | undefined) ?? 1;
  const pair = diffModels.get(`${g}:${path}`);
  if (!ensureDiffEditor() || !pair) return;
  setGroupActive(g, path);
  diffEditor!.setModel({ original: pair.original, modified: pair.modified });
  showDiff(g);
  hooks?.onTabs();
}

export async function closeTab(path: string, group?: EditorGroup) {
  const s = editorStore.get();
  const g = group ?? focusedGroup();
  const tab = s.tabs.find((t) => t.path === path && (t.group || 1) === g);
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
  dropTabs(s.tabs.filter((t) => t.path === path && (t.group || 1) === g));
}

/** Remove tabs without asking (callers confirm first). Shared by all batch closes. */
function dropTabs(gone: Tab[]) {
  if (!gone.length) return;
  const goneKeys = new Set(gone.map((t) => `${t.group || 1}:${t.path}`));
  const s = editorStore.get();
  const rest = s.tabs.filter((t) => !goneKeys.has(`${t.group || 1}:${t.path}`));
  // Shared file models survive while any group still shows the path.
  const live = new Set(rest.map((t) => t.path));
  for (const t of gone) {
    if (!live.has(t.path)) {
      models.get(t.path)?.dispose();
      models.delete(t.path);
    }
    const key = `${t.group || 1}:${t.path}`;
    const pair = diffModels.get(key);
    if (pair) {
      pair.original.dispose();
      pair.modified.dispose();
      diffModels.delete(key);
    }
  }
  const g1 = rest.filter((t) => (t.group || 1) === 1);
  const g2 = rest.filter((t) => (t.group || 1) === 2);
  const active = s.active && g1.some((t) => t.path === s.active) ? s.active : (g1[g1.length - 1]?.path ?? null);
  const active2 = s.active2 && g2.some((t) => t.path === s.active2) ? s.active2 : (g2[g2.length - 1]?.path ?? null);
  const split = s.split && g2.length > 0;
  editorStore.set({ tabs: rest, active, active2, split, focus: split ? s.focus : 1 });
  if (editor && monaco) {
    paintGroupModel(1);
    if (split) paintGroupModel(2);
  }
  hooks?.onTabs();
}

/** Show a group's active tab in its editor (or the diff overlay). */
function paintGroupModel(group: EditorGroup) {
  if (!editor || !monaco) return;
  const s = editorStore.get();
  const path = groupActive(s, group);
  const tab = s.tabs.find((t) => t.path === path && (t.group || 1) === group);
  const pair = path ? diffModels.get(`${group}:${path}`) : undefined;
  const ed = editorFor(group);
  if (!ed) return;
  if (tab?.diff && pair && diffEditor) {
    diffEditor.setModel({ original: pair.original, modified: pair.modified });
    showDiff(group);
  } else {
    showNormal(group);
    ed.setModel(path ? (models.get(path) ?? null) : null);
  }
}

function dirtyAmong(tabs: Tab[]) {
  return tabs.filter((t) => t.dirty);
}

/** One confirm for a batch (VSCode-style) instead of per-tab prompts. */
async function confirmDiscard(tabs: Tab[]): Promise<boolean> {
  const dirty = dirtyAmong(tabs);
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

export async function closeOtherTabs(keep: string, group?: EditorGroup) {
  const g = group ?? focusedGroup();
  const others = editorStore.get().tabs.filter((t) => (t.group || 1) === g && t.path !== keep);
  if (!(await confirmDiscard(others))) return;
  dropTabs(others);
}

export async function closeAllTabs(): Promise<boolean> {
  const all = editorStore.get().tabs;
  if (!(await confirmDiscard(all))) return false;
  dropTabs(all);
  return true;
}

export function closeSavedTabs(group?: EditorGroup) {
  const g = group ?? focusedGroup();
  dropTabs(editorStore.get().tabs.filter((t) => (t.group || 1) === g && !t.dirty));
}

/** Toggle the second editor group. Opening mirrors the current file right
 *  (shared model, instant) when group 2 has nothing to show. */
export function toggleSplit(): boolean {
  const s = editorStore.get();
  if (s.split) {
    closeSplitGroup();
    return false;
  }
  if (!ensureSplitEditor()) {
    hooks?.toast('Split unavailable.', 'error');
    return false;
  }
  const show = s.active && !s.active2 ? s.active : s.active2;
  editorStore.set({ split: true, focus: 2, active2: show ?? null });
  if (show) {
    const pair = diffModels.get(`2:${show}`);
    const tab = editorStore.get().tabs.find((t) => t.path === show && (t.group || 1) === 2);
    if (tab?.diff && pair && diffEditor) {
      diffEditor.setModel({ original: pair.original, modified: pair.modified });
      showDiff(2);
    } else {
      showNormal(2);
      editor2?.setModel(models.get(show) ?? null);
    }
  } else {
    showNormal(2);
    editor2?.setModel(null);
  }
  hooks?.onTabs();
  editor2?.focus();
  return true;
}

/** Close group 2, moving its tabs into group 1 (VSCode semantics). */
export function closeSplitGroup() {
  const s = editorStore.get();
  if (!s.split) return;
  const g1paths = new Set(s.tabs.filter((t) => (t.group || 1) === 1).map((t) => t.path));
  const moved = s.tabs.map((t) => {
    if ((t.group || 1) !== 2) return t;
    if (g1paths.has(t.path)) return null; // already open left — drop the dup
    g1paths.add(t.path);
    return { ...t, group: 1 as const };
  }).filter((t): t is Tab => !!t);
  const active = moved.some((t) => t.path === s.active) ? s.active : (moved[moved.length - 1]?.path ?? null);
  editorStore.set({ tabs: moved, active, active2: null, focus: 1, split: false });
  if (editor && monaco) paintGroupModel(1);
  hooks?.onTabs();
}

/** Focus a group (Ctrl+1 / Ctrl+2), opening the split when targeting 2. */
export function focusGroup(group: EditorGroup) {
  const s = editorStore.get();
  if (group === 2 && !s.split) {
    if (!toggleSplit()) return;
  } else {
    editorStore.set({ focus: group });
  }
  editorFor(group)?.focus();
}

/** Open a path in the group that isn't showing it (tab ctx menu). The tab's
 *  own group decides — not the focused one (they differ right after a
 *  split opens, when focus has already moved right). */
export async function openInOtherGroup(path: string) {
  const s = editorStore.get();
  const tab = s.tabs.find((t) => t.path === path);
  const here = ((tab?.group || 1) as EditorGroup);
  const other = (here === 2 ? 1 : 2) as EditorGroup;
  await openFile(path, { group: other });
}

/** Close a tab and any tabs under it (deleted/renamed folder). False = user cancelled. */
export async function closePathAndChildren(prefix: string): Promise<boolean> {
  const hit = editorStore.get().tabs
    .filter((t) => {
      const p = t.path;
      return p === prefix || p.startsWith(prefix + '/') || p === `diff:${prefix}` || p.startsWith(`diff:${prefix}/`);
    });
  if (!hit.length) return true;
  if (!(await confirmDiscard(hit))) return false;
  dropTabs(hit);
  return true;
}

export async function saveActive(): Promise<boolean> {
  const s = editorStore.get();
  const g = focusedGroup();
  const active = groupActive(s, g);
  const ed = editorFor(g);
  if (!active || !ed) return false;
  const tab = s.tabs.find((t) => t.path === active && (t.group || 1) === g);
  if (tab?.untitled) return saveUntitledAs(tab);
  const model = models.get(active);
  if (!model) return false;
  try {
    const res = await fsApi.write(active, model.getValue());
    editorStore.set((st) => ({
      ...st,
      tabs: st.tabs.map((t) => (t.path === active ? { ...t, dirty: false, mtime: res.mtime } : t)),
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
    dropTabs([tab]);
    if (res.rootRel) {
      await openFile(res.rootRel, { group: tab.group || 1 });
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
  let group = focusedGroup();
  if (group === 2 && (!editorStore.get().split || !ensureSplitEditor())) group = 1;
  untitledSeq++;
  let n = untitledSeq;
  while (editorStore.get().tabs.some((t) => t.path === `untitled:${n}`)) n++;
  untitledSeq = n;
  const path = `untitled:${n}`;
  const model = monaco.editor.createModel('', 'plaintext', monaco.Uri.parse(`inmemory://barang/${path}`));
  models.set(path, model);
  editorStore.set((s) => ({
    ...s,
    tabs: [...s.tabs, { path, title: `Untitled-${n}`, untitled: true, dirty: false, group }],
    active: group === 2 ? s.active : path,
    active2: group === 2 ? path : s.active2,
    focus: group,
  }));
  showNormal(group);
  const ed = editorFor(group);
  suppressDirty = true;
  ed?.setModel(model);
  suppressDirty = false;
  hooks?.onTabs();
  ed?.focus();
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
  const group = focusedGroup();
  void openFile(path, { group }).then(() => {
    const ed = editorFor(group);
    if (line && ed && monaco) {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
    }
  });
}
