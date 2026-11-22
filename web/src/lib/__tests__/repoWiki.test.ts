// Repo wiki: planner, generator, and end-to-end wiring contracts.
//
// The planner/sanitizer are pure and tested directly; runWikiBuild is tested
// with fake model + file reads (no network, no disk). Wiring tests read the
// source files, since there is no headless browser or Electron instance here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AUTO_PAGES_PER_RUN, MAX_MODULES, MAX_WIKI_PAGES, PAGE_SLUG_RE, WIKI_DIR, WIKI_SESSION_TITLE,
  WIKI_VERSION, buildPagePrompt, buildWikiIndexBlock, collectExcerpts, computePageMetas,
  deriveModules, diffFiles, fileStamps, isTestPath, modulePageSlug, parseWikiManifest,
  planGeneration, runWikiBuild, sanitizePageMarkdown, shouldRunAutoSync, summarizePage,
  wikiFingerprint,
  type WikiManifest,
} from '../repoWiki';
import type { IndexedFile, RepoIndex } from '../repoIndex';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const agentTs = read('../agent.ts');
const settingsTs = read('../../ui/settings.ts');
const wikiUiTs = read('../../ui/wiki.ts');
const paletteTs = read('../../ui/palette.ts');
const iconsTs = read('../../ui/icons.ts');
const css = read('../../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const mainTs = read('../../main.ts');
const preloadTs = read('../../../../electron/preload.cjs');
const mainIndexTs = read('../../../../electron/main/index.js');
const mainWikiTs = read('../../../../electron/main/wiki.js');
const transportTs = read('../transport.ts');

const f = (
  path: string,
  size = 100,
  mtime = 1000,
  imports: string[] = [],
  symbols: string[] = [],
): IndexedFile => ({ path, size, mtime, imports, symbols });

const idx = (files: IndexedFile[]): RepoIndex => ({ files, truncated: false, builtAt: 0 });

const makeIndex = () => idx([
  f('src/core/agent.ts', 900, 1000, ['../ui/panel', './util'], ['run']),
  f('src/core/util.ts', 500, 1000, [], ['el', 'debounce']),
  f('src/ui/panel.ts', 700, 1000, ['../core/util'], ['Panel']),
  f('src/ui/styles.css', 300, 1000, [], []),
  f('src/core/agent.test.ts', 200, 1000, [], []),
]);

const manifestFor = (index: RepoIndex, complete = true): WikiManifest => {
  const modules = deriveModules(index.files);
  const pages = computePageMetas(index, modules).map((p) => ({
    ...p,
    summary: `Summary for ${p.title}`,
  }));
  return {
    version: WIKI_VERSION,
    generatedAt: 1000,
    model: 'test/model',
    fingerprint: wikiFingerprint(index.files),
    files: fileStamps(index.files),
    pages,
    modules,
    complete,
  };
};
const slugsOf = (m: WikiManifest) => m.pages.map((p) => p.slug);

describe('module derivation', () => {
  it('classifies test/spec paths', () => {
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('src/__tests__/a.ts')).toBe(true);
    expect(isTestPath('tests/a.ts')).toBe(true);
    expect(isTestPath('src/latest.ts')).toBe(false);
  });

  it('groups non-test files by directory with readable names', () => {
    const modules = deriveModules(makeIndex().files);
    expect(modules.map((m) => m.id)).toEqual(['src-core', 'src-ui']);
    expect(modules.map((m) => m.name)).toEqual(['Core', 'Ui']);
    const all = modules.flatMap((m) => m.paths);
    expect(all).not.toContain('src/core/agent.test.ts');
    expect(all).toHaveLength(4);
  });

  it('resolves relative imports into cross-module relations', () => {
    const modules = deriveModules(makeIndex().files);
    const core = modules.find((m) => m.id === 'src-core');
    const ui = modules.find((m) => m.id === 'src-ui');
    expect(core?.relations).toContainEqual({ type: 'imports', to: 'src-ui' });
    expect(ui?.relations).toContainEqual({ type: 'imports', to: 'src-core' });
  });

  it('merges up to the module cap without losing files', () => {
    const files = [
      f('app/a/x.ts'), f('app/a/y.ts'),
      f('app/b/x.ts'), f('app/b/y.ts'),
      f('app/c/x.ts'), f('app/c/y.ts'),
      f('root.ts'),
    ];
    const modules = deriveModules(files, { maxModules: 2 });
    expect(modules.length).toBeLessThanOrEqual(2);
    const all = modules.flatMap((m) => m.paths).sort();
    expect(all).toEqual(files.map((x) => x.path).sort());
  });

  it('returns nothing for a repo with only tests', () => {
    expect(deriveModules([f('a.test.ts')])).toEqual([]);
  });
});

describe('page plan shape', () => {
  it('builds fixed pages plus one page per module, in presentation order', () => {
    const index = makeIndex();
    const modules = deriveModules(index.files);
    const pages = computePageMetas(index, modules);
    expect(pages.map((p) => p.slug)).toEqual([
      'overview',
      'architecture',
      'module-src-core',
      'module-src-ui',
      'tech-stack',
      'conventions',
    ]);
    expect(modulePageSlug('src/core')).toBe('module-src-core');
    expect(PAGE_SLUG_RE.test(modulePageSlug('src/core'))).toBe(true);
  });

  it('caps sources and picks distinct extensions for the tech stack', () => {
    const index = makeIndex();
    const pages = computePageMetas(index, deriveModules(index.files));
    const stack = pages.find((p) => p.slug === 'tech-stack');
    expect(stack?.sources).toEqual(['src/core/util.ts', 'src/ui/styles.css']);
    for (const p of pages) expect(p.sources.length).toBeLessThanOrEqual(8);
    for (const p of pages) expect(new Set(p.sources).size).toBe(p.sources.length);
  });
});

describe('fingerprint + file diffs', () => {
  it('is stable across ordering and changes with mtime or size', () => {
    const a = makeIndex().files;
    const b = a.slice().reverse();
    expect(wikiFingerprint(a)).toBe(wikiFingerprint(b));
    const touched = a.map((x) => (x.path === 'src/ui/styles.css' ? { ...x, mtime: 2000 } : x));
    expect(wikiFingerprint(touched)).not.toBe(wikiFingerprint(a));
  });

  it('stamps by mtime, falling back to negative size', () => {
    const stamps = fileStamps([f('a.ts', 42, 0), f('b.ts', 7, 99)]);
    expect(stamps).toEqual({ 'a.ts': -42, 'b.ts': 99 });
  });

  it('reports added, changed, and removed files', () => {
    const prev = fileStamps([f('a.ts', 1, 100), f('b.ts', 1, 100)]);
    const next = [f('a.ts', 1, 200), f('b.ts', 1, 100), f('c.ts', 1, 100)];
    expect(diffFiles(prev, next)).toEqual({
      added: ['c.ts'],
      changed: ['a.ts'],
      removed: [],
    });
    expect(diffFiles(prev, [f('a.ts', 1, 100)])).toEqual({
      added: [],
      changed: [],
      removed: ['b.ts'],
    });
    expect(diffFiles(null, next).added).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('planGeneration', () => {
  it('starts with the highest-priority pages and reports the rest as pending', () => {
    const index = makeIndex();
    const plan = planGeneration({ manifest: null, index, now: 5000, maxPages: 2 });
    expect(plan.reason).toBe('Initial build');
    expect(plan.targets.map((t) => t.slug)).toEqual(['overview', 'architecture']);
    expect(plan.allPages).toHaveLength(6);
    expect(plan.pending).toBe(4);
    expect(plan.fresh).toBe(false);
  });

  it('is fresh when the manifest matches the index and every body exists', () => {
    const index = makeIndex();
    const manifest = manifestFor(index);
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.fresh).toBe(true);
    expect(plan.targets).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it('regenerates only pages whose sources changed', () => {
    const before = makeIndex();
    const after = idx(before.files.map((x) => (x.path === 'src/ui/styles.css' ? { ...x, mtime: 2000 } : x)));
    const manifest = manifestFor(before);
    const plan = planGeneration({
      manifest,
      index: after,
      now: 5000,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.targets.map((t) => t.slug)).toEqual([
      'overview',
      'module-src-ui',
      'tech-stack',
    ]);
    for (const target of plan.targets) expect(target.sources).toContain('src/ui/styles.css');
  });

  it('regenerates a page whose body was deleted by hand', () => {
    const index = makeIndex();
    const manifest = manifestFor(index);
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      existingBodies: slugsOf(manifest).filter((s) => s !== 'conventions'),
    });
    expect(plan.targets.map((t) => t.slug)).toEqual(['conventions']);
  });

  it('force rebuilds every page (within the cap)', () => {
    const index = makeIndex();
    const manifest = manifestFor(index);
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      force: true,
      maxPages: 100,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.reason).toBe('Manual rebuild');
    expect(plan.targets).toHaveLength(manifest.pages.length);
    expect(plan.pending).toBe(0);
  });

  it('keeps retrying an incomplete wiki, capped per run', () => {
    const index = makeIndex();
    const manifest = manifestFor(index, false);
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.reason).toBe('Completing wiki');
    expect(plan.targets).toHaveLength(AUTO_PAGES_PER_RUN);
    expect(plan.pending).toBe(manifest.pages.length - AUTO_PAGES_PER_RUN);
  });

  it('refreshes overview/architecture when the module layout changed', () => {
    const index = makeIndex();
    const manifest = { ...manifestFor(index), modules: [] };
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.targets.map((t) => t.slug)).toEqual(['overview', 'architecture']);
  });

  it('prunes pages for modules that disappeared', () => {
    const before = makeIndex();
    const after = idx(before.files.filter((x) => !x.path.startsWith('src/ui/')));
    const manifest = manifestFor(before);
    const plan = planGeneration({
      manifest,
      index: after,
      now: 5000,
      maxPages: 100,
      existingBodies: slugsOf(manifest),
    });
    expect(plan.removed).toContain('module-src-ui');
    expect(plan.allPages.map((p) => p.slug)).not.toContain('module-src-ui');
    expect(plan.fresh).toBe(false);
  });

  it('degrades to fresh when nothing is indexable', () => {
    const plan = planGeneration({ manifest: null, index: idx([]), now: 5000 });
    expect(plan.reason).toBe('No indexable source files');
    expect(plan.fresh).toBe(true);
    expect(plan.targets).toEqual([]);
  });

  it('treats a test-only repo as nothing to index', () => {
    const plan = planGeneration({
      manifest: null,
      index: idx([f('a.test.ts'), f('b.spec.ts')]),
      now: 5000,
    });
    expect(plan.reason).toBe('No indexable source files');
    expect(plan.fresh).toBe(true);
    expect(plan.targets).toEqual([]);
    expect(plan.allPages).toEqual([]);
  });
});

describe('prompt + output handling', () => {
  it('builds a page prompt with identity, modules, excerpts, and rules', () => {
    const index = makeIndex();
    const modules = deriveModules(index.files);
    const page = computePageMetas(index, modules)[0];
    const prompt = buildPagePrompt({
      page,
      fileCount: index.files.length,
      languageSummary: ' (TS 4, CSS 1)',
      truncated: false,
      modules,
      related: computePageMetas(index, modules),
      excerpts: [{ path: 'src/core/util.ts', text: 'export const x = 1;' }],
    });
    expect(prompt).toContain(page.title);
    expect(prompt).toContain('## Modules');
    expect(prompt).toContain('Core:');
    expect(prompt).toContain('### src/core/util.ts');
    expect(prompt).toContain('Output ONLY one markdown page');
  });

  it('unwraps whole fences, drops frontmatter/preface, and adds a heading', () => {
    expect(sanitizePageMarkdown('```markdown\n# T\n\nBody text long enough to be a real page.\n```', { title: 'T' }))
      .toBe('# T\n\nBody text long enough to be a real page.');
    expect(sanitizePageMarkdown('---\ntitle: x\n---\n# T\n\nBody text long enough to be a real page.', { title: 'T' }))
      .toContain('# T');
    expect(sanitizePageMarkdown('Sure, here you go:\n\n# T\n\nBody text long enough to be a real page.', { title: 'T' }))
      .toMatch(/^# T/);
    expect(sanitizePageMarkdown('Body text long enough to be a real page.', { title: 'Named' }))
      .toBe('# Named\n\nBody text long enough to be a real page.');
  });

  it('rejects empty or too-short replies and caps long ones', () => {
    expect(sanitizePageMarkdown('', { title: 'T' })).toBe('');
    expect(sanitizePageMarkdown('# T\n\nnope', { title: 'T' })).toBe('');
    const long = `# T\n\n${'word '.repeat(600)}`;
    const out = sanitizePageMarkdown(long, { title: 'T' }, 120);
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith('…')).toBe(true);
  });

  it('summarizes the first prose line', () => {
    expect(summarizePage('# Title\n\n- **Core** handles state management in the app.\n\nMore.', 'fb'))
      .toContain('Core handles state management');
    expect(summarizePage('# Title\n\n', 'fb')).toBe('fb');
  });
});

describe('manifest parsing + wiki index', () => {
  it('normalizes a manifest and drops invalid entries', () => {
    const parsed = parseWikiManifest({
      version: 1,
      generatedAt: 42,
      model: 'm',
      fingerprint: 'abc',
      complete: true,
      files: { 'a.ts': 10, bad: 'x' },
      pages: [
        { slug: 'overview', title: 'Overview', kind: 'overview', summary: 's', sources: ['a.ts'] },
        { slug: 'Bad Slug', title: 'x', kind: 'module', summary: '', sources: [] },
        { slug: 'overview', title: 'dup', kind: 'module', summary: '', sources: [] },
        { slug: 'module-x', title: 'X', kind: 'weird', summary: 5, sources: [1, 'b.ts'] },
      ],
      modules: [{ id: 'Src Core', name: 'Core', paths: ['a.ts'], relations: [{ type: 'imports', to: 'UI' }] }],
    });
    expect(parsed?.files).toEqual({ 'a.ts': 10 });
    expect(parsed?.pages.map((p) => p.slug)).toEqual(['overview', 'module-x']);
    expect(parsed?.pages[1].kind).toBe('module');
    expect(parsed?.pages[1].sources).toEqual(['b.ts']);
    expect(parsed?.modules[0].id).toBe('src-core');
    expect(parsed?.modules[0].relations).toEqual([{ type: 'imports', to: 'ui' }]);
    expect(parsed?.complete).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(parseWikiManifest(null)).toBeNull();
    expect(parseWikiManifest('x')).toBeNull();
    expect(parseWikiManifest([])).toBeNull();
  });

  it('renders a compact index with page paths and summaries', () => {
    const manifest = manifestFor(makeIndex());
    const block = buildWikiIndexBlock(manifest);
    expect(block).toContain('## Repo wiki');
    expect(block).toContain(`${WIKI_DIR}/pages/overview.md`);
    expect(block).toContain('Summary for Project Overview');
    expect(buildWikiIndexBlock(null)).toBe('');
    const tight = buildWikiIndexBlock(manifest, { maxChars: 220 });
    expect(tight.split('\n').length).toBeLessThan(block.split('\n').length);
  });

  it('caps pages', () => {
    const manifest = manifestFor(makeIndex());
    const block = buildWikiIndexBlock(manifest, { maxPages: 2 });
    expect(block.match(/^- /gm)).toHaveLength(2);
  });
});

describe('excerpts + runWikiBuild', () => {
  it('caps excerpts per file, in total, and by count', async () => {
    const files: Record<string, string> = { 'a.ts': 'abcdefghij', 'b.ts': 'ZZZ', 'c.ts': 'ignored' };
    const out = await collectExcerpts(['a.ts', 'missing.ts', 'b.ts', 'c.ts'], async (p) => files[p] ?? '', {
      perFile: 5,
      total: 8,
      maxFiles: 2,
    });
    expect(out).toEqual([
      { path: 'a.ts', text: 'abcde' },
      { path: 'b.ts', text: 'ZZZ' },
    ]);
  });

  it('generates pages, updates summaries, and reports progress', async () => {
    const index = makeIndex();
    const plan = planGeneration({ manifest: null, index, now: 100, maxPages: 2 });
    const progress: string[] = [];
    const result = await runWikiBuild(plan, {
      readFile: async () => 'export const x = 1;',
      callModel: async () => '# Page\n\nThis is a sufficiently detailed body for the generated wiki page.',
      write: false,
      now: () => 7777,
      onProgress: (ev) => progress.push(`${ev.slug}:${ev.done}/${ev.total}`),
    });
    expect(result.generated).toEqual(['overview', 'architecture']);
    expect(result.failed).toEqual([]);
    expect(result.pending).toBe(plan.pending);
    expect(result.manifest.generatedAt).toBe(7777);
    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.pages[0].summary).toContain('sufficiently detailed body');
    expect(result.written).toBe(false);
    expect(progress).toEqual(['overview:1/2', 'architecture:2/2']);
  });

  it('completes once every page has a body and nothing is pending', async () => {
    const index = makeIndex();
    const plan = planGeneration({ manifest: null, index, now: 100, maxPages: 100 });
    const result = await runWikiBuild(plan, {
      readFile: async () => 'code',
      callModel: async () => '# Page\n\nThis is a sufficiently detailed body for the generated wiki page.',
      write: false,
      now: () => 5000,
    });
    expect(result.manifest.pages).toHaveLength(plan.allPages.length);
    expect(result.manifest.complete).toBe(true);
    expect(result.pending).toBe(0);
  });

  it('keeps existing pages when a model call fails and marks the wiki incomplete', async () => {
    const index = makeIndex();
    const manifest = manifestFor(index, false);
    const plan = planGeneration({
      manifest,
      index,
      now: 5000,
      maxPages: 100,
      existingBodies: slugsOf(manifest),
    });
    const existing = Object.fromEntries(
      slugsOf(manifest).map((s) => [s, `# ${s}\n\nExisting body for ${s} that is long enough.`]),
    );
    const result = await runWikiBuild(plan, {
      readFile: async () => 'code',
      callModel: async (prompt) => (prompt.includes('- Title: Architecture') ? '' : '# Page\n\nFresh body that is definitely long enough for the page.'),
      write: false,
      existingPages: existing,
      now: () => 6000,
    });
    expect(result.failed).toEqual(['architecture']);
    expect(result.pending).toBe(1);
    expect(result.manifest.complete).toBe(false);
    const arch = result.manifest.pages.find((p) => p.slug === 'architecture');
    expect(arch?.summary).toContain('Existing body');
  });
});

describe('auto sync guard', () => {
  const base = {
    enabled: true,
    busy: false,
    running: false,
    root: 'C:/p',
    lastRunAt: 0,
    now: 90_000,
  };

  it('runs when enabled, idle, and outside the cooldown', () => {
    expect(shouldRunAutoSync(base)).toBe(true);
    expect(shouldRunAutoSync({ ...base, lastRunAt: 80_000 })).toBe(false);
    expect(shouldRunAutoSync({ ...base, lastRunAt: 85_000, minIntervalMs: 5_000 })).toBe(true);
  });

  it('never runs disabled, busy, already running, or without a project', () => {
    expect(shouldRunAutoSync({ ...base, enabled: false })).toBe(false);
    expect(shouldRunAutoSync({ ...base, busy: true })).toBe(false);
    expect(shouldRunAutoSync({ ...base, running: true })).toBe(false);
    expect(shouldRunAutoSync({ ...base, root: '' })).toBe(false);
  });
});

describe('storage + bridge wiring', () => {
  it('exposes wiki IPC handlers with strict storage', () => {
    expect(mainIndexTs).toContain("ipcMain.handle('wiki:manifest'");
    expect(mainIndexTs).toContain("ipcMain.handle('wiki:read'");
    expect(mainIndexTs).toContain("ipcMain.handle('wiki:write'");
    expect(mainIndexTs).toContain("ipcMain.handle('wiki:clear'");
    expect(mainIndexTs).toContain("startsWith('.barang/wiki/')");
    expect(mainWikiTs).toContain(`const WIKI_DIR = '${WIKI_DIR}'`);
    expect(mainWikiTs).toContain('MAX_PAGES = 40');
    expect(mainWikiTs).toContain('writeAtomic');
  });

  it('exposes the bridge end-to-end', () => {
    expect(preloadTs).toContain('wiki: {');
    expect(preloadTs).toContain("invoke('wiki:write'");
    expect(transportTs).toContain('interface WikiManifestData');
    expect(transportTs).toContain('wiki: {');
    expect(transportTs).toContain('manifest(): Promise<WikiManifestData | null>');
  });
});

describe('agent wiring', () => {
  it('adds a default-on setting persisted through readSettings', () => {
    expect(agentTs).toContain('repoWikiEnabled: boolean');
    expect(agentTs).toContain('repoWikiEnabled: true');
    expect(agentTs).toContain('repoWikiEnabled: p.repoWikiEnabled !== false');
  });

  it('injects a compact wiki index and gates it on the setting', () => {
    expect(agentTs).toContain('settings.repoWikiEnabled ? loadWikiBlock() : Promise.resolve(\'\')');
    expect(agentTs).toContain('async function loadWikiBlock()');
    expect(agentTs).toContain('buildWikiIndexBlock(await readWikiManifest())');
    expect(agentTs).toContain('if (wiki) parts.push(wiki)');
  });

  it('syncs automatically after turns, on boot/file changes, and hides its sessions', () => {
    expect(agentTs).toContain('void syncRepoWiki(\'turn\').catch(() => {})');
    expect(agentTs).toContain('scheduleWikiSync()');
    expect(agentTs).toContain('WIKI_SESSION_TITLE');
    expect(agentTs).toContain('String(title ?? \'\') === WIKI_SESSION_TITLE');
    expect(mainTs).toContain('scheduleWikiSync()');
    expect(mainTs).toContain('btnWiki');
  });

  it('plans from the shared repo index and caps auto runs', () => {
    expect(agentTs).toContain('planGeneration({');
    expect(agentTs).toContain('runWikiBuild(plan, {');
    expect(agentTs).toContain('shouldRunAutoSync({');
  });
});

describe('settings + UI wiring', () => {
  it('adds a Repo wiki section right after Repo map', () => {
    const m = /const SECTIONS = \[([^\]]+)\]/.exec(settingsTs);
    expect(m).toBeTruthy();
    const sections = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    const map = sections.indexOf('Repo map');
    expect(map).toBeGreaterThanOrEqual(0);
    expect(sections[map + 1]).toBe('Repo wiki');
    expect(settingsTs).toContain("section('Repo wiki')");
    expect(settingsTs).toContain('repoWikiBox');
    expect(settingsTs).toContain('openWiki({ toast: hooks.toast })');
  });

  it('rebuilds from settings with a confirmation', () => {
    expect(settingsTs).toContain("syncRepoWiki('manual', { force: true })");
    expect(settingsTs).toContain('Rebuild the repo wiki?');
  });

  it('ships a viewer, a topbar entry, a palette command, and an icon', () => {
    expect(wikiUiTs).toContain('.wiki-overlay');
    expect(wikiUiTs).toContain('article.innerHTML = md(body)');
    expect(wikiUiTs).toContain("syncRepoWiki('manual')");
    expect(paletteTs).toContain("id: 'wiki.open'");
    expect(paletteTs).toContain("id === 'wiki.open'");
    expect(iconsTs).toContain('book: S(');
    expect(css).toContain('.wiki-overlay');
    expect(css).toContain('.wiki-modal');
    expect(css).toContain('.wiki-settings-actions');
  });
});

describe('constants stay within the storage contract', () => {
  it('matches the main-process page cap and slug rules', () => {
    expect(MAX_WIKI_PAGES).toBe(40);
    expect(WIKI_VERSION).toBe(1);
    expect(MAX_MODULES).toBeLessThanOrEqual(MAX_WIKI_PAGES);
    expect(WIKI_SESSION_TITLE.startsWith('__barang_')).toBe(true);
  });
});
