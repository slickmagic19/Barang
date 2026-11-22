// Repo map prototype: path filtering, per-language symbol extraction, the
// compact map renderer, and the wiring into the turn augmentation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildRepoIndex, buildRepoMap, extOf, isIndexablePath, parseSymbols, rankFiles, tokenizeQuery,
  QUERY_MAX_FILES, CORE_MAX_FILES,
  type IndexedFile, type RepoIndex,
} from '../repoIndex';
import { augmentationBlock } from '../agent';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentTs = readFileSync(path.resolve(here, '..', 'agent.ts'), 'utf8');
const settingsTs = readFileSync(path.resolve(here, '..', '..', 'ui', 'settings.ts'), 'utf8');

const file = (p: string, symbols: string[] = []): IndexedFile => ({ path: p, size: 100, symbols, imports: [] });
const index = (files: IndexedFile[], truncated = false): RepoIndex => ({ files, truncated, builtAt: 1 });

describe('isIndexablePath', () => {
  it('accepts source files', () => {
    for (const p of ['src/app.ts', 'web/src/ui/chat.tsx', 'script.py', 'main.go', 'lib.rs', 'styles.css']) {
      expect(isIndexablePath(p)).toBe(true);
    }
  });

  it('rejects builds, deps, lockfiles, assets and maps', () => {
    for (const p of [
      'node_modules/pkg/index.js', 'web/dist/app.js', 'build/x.cs', 'release/app.exe',
      'README.md', 'package-lock.json', 'bundle.min.js', 'out.js.map', 'logo.png',
    ]) {
      expect(isIndexablePath(p)).toBe(false);
    }
  });

  it('reads extensions', () => {
    expect(extOf('a/b/c.TSX')).toBe('tsx');
    expect(extOf('Makefile')).toBe('');
  });
});

describe('parseSymbols — TypeScript/JavaScript', () => {
  const src = `
import fs from 'node:fs';
import './side-effect';
const y = require('../legacy');
export function run(x: number) { return x; }
export default class Engine {}
export const LIMIT = 3;
export interface Options { a: string }
export type Id = string;
export enum Mode { A }
function internalHelper() {}
export { a, b as c };
`;
  const out = parseSymbols('src/lib/thing.ts', src);

  it('extracts exported and re-exported names', () => {
    for (const name of ['run', 'Engine', 'LIMIT', 'Options', 'Id', 'Mode', 'a', 'c']) {
      expect(out.symbols).toContain(name);
    }
  });

  it('extracts import specifiers', () => {
    expect(out.imports).toEqual(expect.arrayContaining(['node:fs', './side-effect', '../legacy']));
  });

  it('falls back to top-level declarations when nothing is exported', () => {
    const plain = parseSymbols('src/main.js', 'function boot() {}\nclass App {}');
    expect(plain.symbols).toEqual(['boot', 'App']);
  });

  it('caps the symbol list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `export const s${i} = ${i};`).join('\n');
    expect(parseSymbols('a.ts', many).symbols).toHaveLength(12);
  });
});

describe('parseSymbols — other languages', () => {
  it('python: top-level defs/classes only, plus imports', () => {
    const src = 'import os\nfrom pkg.mod import thing\nclass App:\n    def method(self):\n        pass\ndef run():\n    pass\n';
    const out = parseSymbols('app.py', src);
    expect(out.symbols).toEqual(['App', 'run']);
    expect(out.symbols).not.toContain('method');
    expect(out.imports).toEqual(expect.arrayContaining(['os', 'pkg.mod']));
  });

  it('go: exported funcs/types and import block specs', () => {
    const src = 'package main\nimport (\n  "fmt"\n  alias "example.com/x"\n)\ntype Server struct{}\nfunc (s *Server) Start() {}\nfunc helper() {}\n';
    const out = parseSymbols('main.go', src);
    expect(out.symbols).toEqual(expect.arrayContaining(['Server', 'Start']));
    expect(out.symbols).not.toContain('helper');
    expect(out.imports).toEqual(expect.arrayContaining(['fmt', 'example.com/x']));
  });

  it('rust: pub items and use paths', () => {
    const src = 'use crate::api;\npub struct Engine;\npub async fn run() {}\nfn private_helper() {}\n';
    const out = parseSymbols('lib.rs', src);
    expect(out.symbols).toEqual(expect.arrayContaining(['Engine', 'run', 'private_helper']));
    expect(out.imports).toContain('crate::api');
  });
});

describe('buildRepoMap', () => {
  it('is empty without files', () => {
    expect(buildRepoMap(null)).toBe('');
    expect(buildRepoMap(index([]))).toBe('');
  });

  it('renders paths, exports and a language summary', () => {
    const map = buildRepoMap(index([
      file('src/lib/agent.ts', ['agentStore', 'sendMessage']),
      file('src/ui/chat.ts', ['initChat']),
      file('src/styles.css'),
    ]));
    expect(map).toContain('## Repository map');
    expect(map).toContain('Indexed 3 source files');
    expect(map).toContain('TS 2');
    expect(map).toContain('- src/lib/agent.ts [TS] — agentStore, sendMessage');
    expect(map).toContain('- src/styles.css [CSS]');
  });

  it('ranks files by internal import in-degree', () => {
    const map = buildRepoMap(index([
      file('src/deep/app.ts'),
      file('src/lib/core.ts'),
      { path: 'src/lib/feature.ts', size: 1, symbols: [], imports: ['../lib/core'] },
      { path: 'src/ui/view.ts', size: 1, symbols: [], imports: ['../lib/core'] },
    ]));
    expect(map.indexOf('core.ts')).toBeLessThan(map.indexOf('app.ts'));
    expect(map.indexOf('core.ts')).toBeLessThan(map.indexOf('feature.ts'));
  });

  it('sorts shallow files first and honors maxFiles', () => {
    const map = buildRepoMap(index([
      file('a/b/c/deep.ts', ['x']),
      file('top.ts', ['y']),
      file('a/mid.ts', ['z']),
    ]), { maxFiles: 2 });
    expect(map.indexOf('top.ts')).toBeLessThan(map.indexOf('a/mid.ts'));
    expect(map).not.toContain('deep.ts');
    expect(map).toContain('1 more file not shown');
  });

  it('honors the character budget', () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`src/dir${i}/file${i}.ts`, ['a', 'b', 'c']));
    const map = buildRepoMap(index(files), { maxChars: 900 });
    expect(map.length).toBeLessThan(1200); // header + lines + omission note
    expect(map).toContain('more files not shown');
  });

  it('marks a truncated scan', () => {
    const map = buildRepoMap(index([file('a.ts', ['x'])], true));
    expect(map).toContain('scan truncated');
  });
});

describe('query-conditioned retrieval', () => {
  const ctx = (): IndexedFile[] => [
    file('src/lib/agent.ts', ['sendMessage']),
    file('src/ui/chat.ts', ['initChat']),
    file('src/lib/util.ts', ['formatDate']),
    { path: 'src/ui/view.ts', size: 1, symbols: [], imports: ['../lib/util'] },
    { path: 'src/ui/panel.ts', size: 1, symbols: [], imports: ['../lib/util'] },
  ];

  it('tokenizes queries: lowercases, drops stopwords/short tokens, dedupes', () => {
    expect(tokenizeQuery('Fix the SendMessage bug in agent.ts')).toEqual(['sendmessage', 'bug', 'agent', 'ts']);
    expect(tokenizeQuery('a I agent agent AGENT go')).toEqual(['agent', 'go']);
    expect(tokenizeQuery('   ')).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => `tok${i}`).join(' ');
    expect(tokenizeQuery(many)).toHaveLength(40);
  });

  it('ranks files by path/symbol relevance and fills with most-imported files', () => {
    const ranked = rankFiles(ctx(), 'send message');
    expect(ranked.matches.map((f) => f.path)).toEqual(['src/lib/agent.ts']);
    expect(ranked.core[0].path).toBe('src/lib/util.ts');
    const limited = rankFiles(ctx(), 'send message', { coreFiles: 2 });
    expect(limited.core).toHaveLength(2);
    expect(limited.core.map((f) => f.path)).not.toContain('src/lib/agent.ts');
  });

  it('caps matches and core files', () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`src/mod/agent${i}.ts`, ['x']));
    files.push(file('src/core.ts', ['core']));
    const ranked = rankFiles(files, 'agent');
    expect(ranked.matches).toHaveLength(QUERY_MAX_FILES);
    expect(ranked.core).toHaveLength(CORE_MAX_FILES);
  });

  it('lists only matching files, then a core section', () => {
    const map = buildRepoMap(index(ctx()), { query: 'send message' });
    expect(map).toContain('Files matching this request');
    expect(map).toContain('- src/lib/agent.ts [TS] — sendMessage');
    expect(map).not.toContain('No file matched');
    const corePos = map.indexOf('Most-imported files (project context):');
    expect(corePos).toBeGreaterThan(-1);
    expect(map.indexOf('src/lib/agent.ts')).toBeLessThan(corePos);
    expect(map.indexOf('src/lib/util.ts')).toBeGreaterThan(corePos);
  });

  it('falls back to orientation text when nothing matches', () => {
    const map = buildRepoMap(index([file('src/a.ts', ['x']), file('src/b.ts', ['y'])]), { query: 'kubernetes yaml' });
    expect(map).toContain('No file matched this request');
    expect(map).toContain('Most-imported files (project context):');
  });

  it('keeps query mode within the character budget', () => {
    const files = Array.from({ length: 60 }, (_, i) => file(`src/dir${i}/file${i}.ts`, ['a', 'b', 'c']));
    const map = buildRepoMap(index(files), { query: 'file', maxChars: 900 });
    expect(map.length).toBeLessThan(1200);
    expect(map).toContain('more files not shown');
  });

  it('keeps the full-map mode when query is undefined', () => {
    const map = buildRepoMap(index(ctx()));
    expect(map).toContain('use this map to locate code');
    expect(map).not.toContain('Most-imported files (project context):');
  });
});

describe('buildRepoIndex — bridge scan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists, filters, parses and skips unreadable files', async () => {
    const files = ['src/a.ts', 'node_modules/x/i.js', 'src/b.py', 'README.md', 'src/locked.ts'];
    vi.stubGlobal('window', {
      barang: {
        fs: {
          listFiles: async () => ({ files, truncated: false }),
          read: async (p: string) => {
            if (p === 'src/locked.ts') throw new Error('denied');
            if (p === 'src/b.py') return { content: 'import os\ndef run():\n    pass\n', size: 30 };
            return { content: 'export const x = 1;\n', size: 20 };
          },
        },
      },
    });
    const idx = await buildRepoIndex('/proj');
    expect(idx.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.py']);
    expect(idx.files.find((f) => f.path === 'src/a.ts')?.symbols).toEqual(['x']);
    expect(idx.files.find((f) => f.path === 'src/b.py')?.symbols).toEqual(['run']);
  });

  it('returns an empty index when the bridge fails', async () => {
    vi.stubGlobal('window', { barang: { fs: { listFiles: async () => { throw new Error('no root'); } } } });
    await expect(buildRepoIndex('/proj')).resolves.toMatchObject({ files: [] });
  });
});

describe('augmentation wiring', () => {
  it('appends the repo map after skills and memory', () => {
    const block = augmentationBlock(
      [{ name: 'pdf', description: 'Use for PDFs.', scope: 'user', dir: 'pdf', path: '', file: '', size: 0 }],
      [{ slug: 'user-role', title: 'User role', hook: '', type: 'user', scope: 'user', body: 'Engineer.', file: '', mtime: 1 }],
      '## Repository map\n- src/a.ts [TS] — run',
    );
    expect(block).toContain('## Available Skills');
    expect(block).toContain('## Memory');
    expect(block).toContain('## Repository map');
    expect(block.indexOf('## Memory')).toBeLessThan(block.indexOf('## Repository map'));
  });

  it('gates the repo map behind a setting and loads it in parallel', () => {
    expect(agentTs).toContain('repoMapEnabled: p.repoMapEnabled !== false');
    expect(agentTs).toContain('settings.repoMapEnabled ? loadRepoMap(repoQuery) : Promise.resolve(\'\')');
    expect(agentTs).toContain('export async function loadRepoMap');
    expect(agentTs).toContain('invalidateRepoMap(ev?.root)');
  });

  it('passes the request text into repo map retrieval', () => {
    expect(agentTs).toContain('async function currentAugmentation(query = \'\')');
    expect(agentTs).toContain('const augmentation = await currentAugmentation(body)');
    expect(agentTs).toContain('currentAugmentation(`${name} ${args}`)');
    expect(agentTs).toContain('function lastUserQuery()');
    expect(agentTs).toContain('const index = await getRepoIndex(root)');
    expect(agentTs).toContain('return index ? buildRepoMap(index, { query }) : \'\'');
  });

  it('persists the memory auto-update toggle (readSettings round-trip)', () => {
    expect(agentTs).toContain('memoryAutoUpdate: p.memoryAutoUpdate !== false');
  });

  it('mentions the repo map in the context wrapper', () => {
    expect(agentTs).toContain('skills + memory + repo map');
  });

  it('exposes a Repo map settings section', () => {
    expect(settingsTs).toContain("section('Repo map')");
    expect(settingsTs).toContain('repoMapEnabled');
  });
});
