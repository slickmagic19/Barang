// Seti-style file icons: filled doc + brand color + white glyph, fixed colors
// (like VS Code — file icons keep their identity in any theme). One doc shape,
// compact glyph arts, exact-filename matching first, then extension.
interface Spec { c: string; t?: string; g?: string; a?: keyof typeof ART }

const ART = {
  gear: '<circle cx="8" cy="9.8" r="2.5" fill="none" stroke="#fff" stroke-width="1.3"/><circle cx="8" cy="9.8" r="0.8" fill="#fff"/><path d="M8 6.2v1M8 12.4v1M4.9 8l.9.5M10.2 11.1l.9.5M4.9 11.6l.9-.5M10.2 8.5l.9-.5" stroke="#fff" stroke-width="1.1"/>',
  lock: '<rect x="6" y="9.4" width="4" height="3.2" rx="0.6" fill="#fff"/><path d="M6.7 9.4V8a1.3 1.3 0 0 1 2.6 0v1.4" fill="none" stroke="#fff" stroke-width="1"/>',
  key: '<circle cx="6.5" cy="8.3" r="1.5" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M7.7 9.3l2.5 2.5M9.3 10.4l.8-.8M8.7 11.2l.7-.7" stroke="#fff" stroke-width="1.1"/>',
  branch: '<circle cx="6" cy="7.4" r="1.1" fill="#fff"/><circle cx="6" cy="12" r="1.1" fill="#fff"/><circle cx="10.2" cy="7.4" r="1.1" fill="#fff"/><path d="M6 8.5v2.4M6 11c0-1.5 1.2-1.6 2.2-1.6h1" fill="none" stroke="#fff" stroke-width="1"/>',
  img: '<rect x="4.8" y="6.8" width="6.4" height="4.9" rx="0.7" fill="none" stroke="#fff" stroke-width="1.1"/><circle cx="6.8" cy="8.5" r="0.7" fill="#fff"/><path d="M5.3 10.9l1.7-1.7 1.2 1.2 1-1 1.4 1.4" fill="none" stroke="#fff" stroke-width="1"/>',
  play: '<path d="M6.9 7.4l3.6 2.4-3.6 2.4z" fill="#fff"/>',
  db: '<ellipse cx="8" cy="7.9" rx="2.6" ry="1" fill="none" stroke="#fff" stroke-width="1"/><path d="M5.4 7.9v3.3c0 .6 1.2 1 2.6 1s2.6-.4 2.6-1V7.9" fill="none" stroke="#fff" stroke-width="1"/>',
  grid: '<rect x="5" y="7.3" width="6" height="4.6" rx="0.5" fill="none" stroke="#fff" stroke-width="1"/><path d="M5 9.2h6M8 7.3v4.6" stroke="#fff" stroke-width="0.9"/>',
  box: '<path d="M5 8.2l3-1.5 3 1.5v3l-3 1.5-3-1.5z" fill="none" stroke="#fff" stroke-width="1"/><path d="M5 8.2l3 1.4 3-1.4M8 9.6v3" fill="none" stroke="#fff" stroke-width="0.9"/>',
  win: '<rect x="5.7" y="7.5" width="2" height="2" fill="#fff"/><rect x="8.3" y="7.5" width="2" height="2" fill="#fff"/><rect x="5.7" y="10" width="2" height="2" fill="#fff"/><rect x="8.3" y="10" width="2" height="2" fill="#fff"/>',
  lines: '<path d="M5.5 8.2h5M5.5 9.9h5M5.5 11.6h3.4" stroke="#fff" stroke-width="1.1"/>',
  diamond: '<rect x="6.3" y="8.1" width="3.4" height="3.4" transform="rotate(45 8 9.8)" fill="#fff"/>',
  dot: '<circle cx="8" cy="9.8" r="1.7" fill="#fff"/>',
  check: '<path d="M5.7 9.9l1.6 1.6 3.1-3.6" fill="none" stroke="#fff" stroke-width="1.4"/>',
};

const JSON_Y: Spec = { c: '#cfc03a', g: '#4a3a00', t: '{}' };
const LOCK: Spec = { c: '#7d7d7d', a: 'lock' };
const GIT: Spec = { c: '#f14e32', a: 'branch' };
const DOCKER: Spec = { c: '#499fdb', t: 'D' };
const GEAR_GRAY: Spec = { c: '#7d7d7d', a: 'gear' };
const README: Spec = { c: '#2f7fc4', t: 'i' };
const LICENSE: Spec = { c: '#ddb91e', g: '#4a3a00', a: 'key' };
const DOTNET: Spec = { c: '#9b4f96', t: 'C#' };

// Exact filenames (lowercase).
const EXACT: Record<string, Spec> = {
  'package.json': JSON_Y, 'composer.json': JSON_Y,
  'package-lock.json': LOCK, 'composer.lock': LOCK, 'yarn.lock': LOCK, 'pnpm-lock.yaml': LOCK,
  'poetry.lock': LOCK, 'pipfile.lock': LOCK, 'gemfile.lock': LOCK, 'pubspec.lock': LOCK,
  'go.mod': { c: '#00add8', t: 'GO' }, 'go.sum': { c: '#00add8', a: 'lock' },
  'cargo.toml': { c: '#b7410e', a: 'gear' }, 'cargo.lock': LOCK,
  'dockerfile': DOCKER, '.dockerignore': DOCKER,
  '.gitignore': GIT, '.gitattributes': GIT, '.gitmodules': GIT, '.gitkeep': GIT,
  '.npmrc': { c: '#cb3837', t: 'n' }, '.nvmrc': { c: '#5fa04e', t: 'N' },
  'license': LICENSE, 'license.md': LICENSE, 'license.txt': LICENSE, 'copying': LICENSE,
  'readme.md': README, 'readme.txt': README, 'readme': README,
  'changelog.md': README, 'contributing.md': README,
  'makefile': { c: '#8a6d3b', t: 'M' }, 'cmakelists.txt': { c: '#c42e1f', t: 'M' },
  'gemfile': { c: '#cc342d', a: 'diamond' }, 'rakefile': { c: '#cc342d', a: 'diamond' },
  '.editorconfig': GEAR_GRAY,
};

// Filename prefixes (lowercase): Dockerfile.dev, .env.local, tsconfig.app.json…
const PREFIX: Array<[string, Spec]> = [
  ['dockerfile', DOCKER], ['docker-compose', DOCKER],
  ['.env', { c: '#8a9a5b', a: 'gear' }],
  ['readme', README], ['changelog', README], ['contributing', README],
  ['license', LICENSE], ['copying', LICENSE],
  ['makefile', { c: '#8a6d3b', t: 'M' }], ['cmake', { c: '#c42e1f', t: 'M' }],
  ['tsconfig', { c: '#2f7fc4', t: '{}' }], ['jsconfig', JSON_Y],
  ['vite.config', { c: '#a855f7', t: 'V' }], ['vitest', { c: '#a855f7', t: 'V' }],
  ['webpack', { c: '#2b7cb9', t: 'W' }], ['rollup.config', { c: '#ec4a3f', t: 'R' }],
  ['eslint', { c: '#7c7cf4', t: 'ES' }], ['prettier', { c: '#c7a06a', a: 'check' }],
  ['babel', { c: '#c9a227', g: '#4a3a00', t: 'B' }],
  ['.gitlab-ci', { c: '#e24329', t: 'G' }],
  ['gemfile', { c: '#cc342d', a: 'diamond' }],
];

// Extensions (lowercase, no dot).
const EXTS: Record<string, Spec> = {
  js: { c: '#ddb91e', g: '#4a3a00', t: 'JS' }, jsx: { c: '#ddb91e', g: '#4a3a00', t: 'JS' },
  mjs: { c: '#ddb91e', g: '#4a3a00', t: 'JS' }, cjs: { c: '#ddb91e', g: '#4a3a00', t: 'JS' },
  ts: { c: '#2f7fc4', t: 'TS' }, tsx: { c: '#2f7fc4', t: 'TS' },
  mts: { c: '#2f7fc4', t: 'TS' }, cts: { c: '#2f7fc4', t: 'TS' },
  json: JSON_Y, jsonc: JSON_Y, json5: JSON_Y, jsonl: JSON_Y, ndjson: JSON_Y, har: JSON_Y,
  html: { c: '#e44d26', t: '</>' }, htm: { c: '#e44d26', t: '</>' },
  xml: { c: '#d97a2b', t: '</>' }, xsl: { c: '#d97a2b', t: '</>' }, xaml: { c: '#d97a2b', t: '</>' },
  vue: { c: '#41b883', t: 'V' }, svelte: { c: '#ff3e00', t: 'S' }, astro: { c: '#ff5d01', t: 'A' },
  css: { c: '#42a5f5', t: '#' }, scss: { c: '#cd6799', t: '#' }, sass: { c: '#cd6799', t: '#' }, less: { c: '#2b6cb0', t: '#' },
  md: { c: '#2f7fc4', t: 'M' }, mdx: { c: '#2f7fc4', t: 'M' }, markdown: { c: '#2f7fc4', t: 'M' },
  txt: { c: '#8a8a8a', a: 'lines' }, log: { c: '#8a8a8a', a: 'lines' },
  py: { c: '#3572A5', t: 'PY' }, pyi: { c: '#3572A5', t: 'PY' }, pyw: { c: '#3572A5', t: 'PY' },
  rs: { c: '#b7410e', t: 'RS' }, go: { c: '#00add8', t: 'GO' },
  java: { c: '#e76f00', t: 'JV' }, kt: { c: '#7f52ff', t: 'KT' }, kts: { c: '#7f52ff', t: 'KT' },
  php: { c: '#777bb3', t: 'PHP' }, rb: { c: '#cc342d', t: 'RB' }, swift: { c: '#f05138', t: 'SW' },
  c: { c: '#659ad2', t: 'C' }, h: { c: '#659ad2', t: 'C' },
  cpp: { c: '#2f6cb0', t: 'C+' }, hpp: { c: '#2f6cb0', t: 'C+' }, cc: { c: '#2f6cb0', t: 'C+' }, cxx: { c: '#2f6cb0', t: 'C+' },
  cs: DOTNET, cshtml: DOTNET, razor: DOTNET,
  fs: { c: '#378bba', t: 'F' }, fsx: { c: '#378bba', t: 'F' },
  m: { c: '#5b8fd4', t: 'M' }, mm: { c: '#5b8fd4', t: 'M' },
  dart: { c: '#0aa396', t: 'D' }, lua: { c: '#2c2d72', t: 'L' },
  r: { c: '#276dc3', t: 'R' }, jl: { c: '#9558b2', t: 'JL' },
  scala: { c: '#dc322f', t: 'S' }, hs: { c: '#5e5086', t: 'λ' },
  clj: { c: '#6d8f2f', t: 'λ' }, cljs: { c: '#6d8f2f', t: 'λ' },
  ex: { c: '#6e4a7e', t: 'E' }, exs: { c: '#6e4a7e', t: 'E' },
  erl: { c: '#a90533', t: 'E' }, hrl: { c: '#a90533', t: 'E' },
  elm: { c: '#3d93b5', t: 'E' }, groovy: { c: '#4298b8', t: 'G' },
  pl: { c: '#244d85', t: 'P' }, pm: { c: '#244d85', t: 'P' },
  ml: { c: '#e07a3f', t: 'M' }, mli: { c: '#e07a3f', t: 'M' },
  sol: { c: '#9945ff', t: 'S' }, zig: { c: '#d99a1f', g: '#4a3a00', t: 'Z' },
  nim: { c: '#c9a227', g: '#4a3a00', t: 'N' }, d: { c: '#b03931', t: 'D' },
  vim: { c: '#019733', t: 'V' },
  sh: { c: '#3f4a4e', t: '>_' }, bash: { c: '#3f4a4e', t: '>_' }, zsh: { c: '#3f4a4e', t: '>_' }, fish: { c: '#3f4a4e', t: '>_' },
  ps1: { c: '#1f4e8c', t: '>_' }, psm1: { c: '#1f4e8c', t: '>_' }, bat: { c: '#7a7a7a', t: '>_' }, cmd: { c: '#7a7a7a', t: '>_' },
  sql: { c: '#e38c00', a: 'db' }, db: { c: '#e38c00', a: 'db' }, sqlite: { c: '#e38c00', a: 'db' }, sqlite3: { c: '#e38c00', a: 'db' },
  yml: { c: '#cb171e', a: 'lines' }, yaml: { c: '#cb171e', a: 'lines' },
  toml: { c: '#6e6e6e', t: '{}' }, ini: { c: '#7a7a7a', a: 'gear' }, cfg: { c: '#7a7a7a', a: 'gear' },
  conf: { c: '#7a7a7a', a: 'gear' }, properties: { c: '#7a7a7a', a: 'gear' },
  svg: { c: '#9a5fa0', a: 'img' },
  png: { c: '#7d5ba6', a: 'img' }, jpg: { c: '#7d5ba6', a: 'img' }, jpeg: { c: '#7d5ba6', a: 'img' },
  gif: { c: '#7d5ba6', a: 'img' }, webp: { c: '#7d5ba6', a: 'img' }, bmp: { c: '#7d5ba6', a: 'img' },
  ico: { c: '#7d5ba6', a: 'img' }, avif: { c: '#7d5ba6', a: 'img' },
  psd: { c: '#8a5f9e', a: 'img' }, ai: { c: '#8a5f9e', a: 'img' }, eps: { c: '#8a5f9e', a: 'img' },
  sketch: { c: '#8a5f9e', a: 'img' }, fig: { c: '#8a5f9e', a: 'img' },
  mp4: { c: '#6a63d6', a: 'play' }, mov: { c: '#6a63d6', a: 'play' }, webm: { c: '#6a63d6', a: 'play' },
  mkv: { c: '#6a63d6', a: 'play' }, avi: { c: '#6a63d6', a: 'play' },
  mp3: { c: '#8f6fc0', t: '♪' }, wav: { c: '#8f6fc0', t: '♪' }, ogg: { c: '#8f6fc0', t: '♪' }, flac: { c: '#8f6fc0', t: '♪' }, m4a: { c: '#8f6fc0', t: '♪' },
  woff: { c: '#7a7a7a', t: 'A' }, woff2: { c: '#7a7a7a', t: 'A' }, ttf: { c: '#7a7a7a', t: 'A' }, otf: { c: '#7a7a7a', t: 'A' }, eot: { c: '#7a7a7a', t: 'A' },
  pdf: { c: '#d93b3b', a: 'lines' },
  zip: { c: '#b39a45', a: 'box' }, tar: { c: '#b39a45', a: 'box' }, gz: { c: '#b39a45', a: 'box' },
  bz2: { c: '#b39a45', a: 'box' }, xz: { c: '#b39a45', a: 'box' }, '7z': { c: '#b39a45', a: 'box' }, rar: { c: '#b39a45', a: 'box' },
  img: { c: '#7a7a7a', a: 'box' }, apk: { c: '#7a7a7a', a: 'box' }, dmg: { c: '#7a7a7a', a: 'box' }, iso: { c: '#7a7a7a', a: 'box' },
  exe: { c: '#4a90d9', a: 'win' }, msi: { c: '#4a90d9', a: 'win' }, dll: { c: '#4a90d9', a: 'win' },
  map: { c: '#666666', t: '{}' },
  graphql: { c: '#e535ab', a: 'diamond' }, gql: { c: '#e535ab', a: 'diamond' },
  prisma: { c: '#0c7c86', t: 'P' }, proto: { c: '#5b7fa6', t: 'P' },
  tf: { c: '#7b42bc', t: 'T' }, hcl: { c: '#7b42bc', t: 'T' },
  csv: { c: '#6aab73', a: 'grid' }, tsv: { c: '#6aab73', a: 'grid' },
  ipynb: { c: '#e98300', a: 'dot' },
  tex: { c: '#3d65a5', t: 'T' }, bib: { c: '#3d65a5', t: 'T' },
  diff: { c: '#7a7a7a', t: '±' }, patch: { c: '#7a7a7a', t: '±' },
  pem: { c: '#6aab73', a: 'key' }, key: { c: '#6aab73', a: 'key' }, crt: { c: '#6aab73', a: 'key' }, cer: { c: '#6aab73', a: 'key' },
  lock: LOCK, sum: { c: '#7a7a7a', a: 'lines' },
  bak: { c: '#666666', a: 'lines' }, tmp: { c: '#666666', a: 'lines' }, swp: { c: '#666666', a: 'lines' },
  gradle: { c: '#23a97b', t: 'G' },
  pug: { c: '#a86454', t: 'P' }, jade: { c: '#a86454', t: 'P' },
  twig: { c: '#8aa83e', t: 'T' }, liquid: { c: '#6aa84f', t: 'L' }, njk: { c: '#1e8e3e', t: 'N' },
  hbs: { c: '#e67e22', t: '{}' }, handlebars: { c: '#e67e22', t: '{}' }, mustache: { c: '#e67e22', t: '{}' },
  ejs: { c: '#e44d26', t: '</>' }, erb: { c: '#e44d26', t: '</>' },
  coffee: { c: '#244354', t: 'C' },
};

export function fileSpec(name: string): Spec | null {
  const base = name.split('/').pop()?.toLowerCase() ?? '';
  if (EXACT[base]) return EXACT[base];
  for (const [p, s] of PREFIX) if (base.startsWith(p)) return s;
  const i = base.lastIndexOf('.');
  if (i > 0) {
    const ext = base.slice(i + 1);
    if (EXTS[ext]) return EXTS[ext];
  }
  return null;
}

function render(spec: Spec): string {
  const glyph = spec.g ?? '#fff';
  let inner: string;
  if (spec.a) {
    inner = ART[spec.a];
  } else {
    const label = spec.t ?? '';
    // textLength pins the monogram to the doc width at any size.
    const w = label.length <= 1 ? 4.4 : label.length === 2 ? 6.8 : 8;
    const fs = label.length >= 3 ? 5.6 : label.length === 2 && /[<>/{}/_]/.test(label) ? 6 : 7;
    inner = `<text x="8" y="11.9" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fs}" font-weight="800" fill="${glyph}" textLength="${w}" lengthAdjust="spacingAndGlyphs">${label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>`;
  }
  return `<svg viewBox="0 0 16 16"><path d="M4 1.2h5.2L12.5 4v10.8H4z" fill="${spec.c}"/><path d="M9.2 1.2V4h3.3z" fill="#000" opacity=".25"/>${inner}</svg>`;
}

/** File-type icon span (classes `ic fi` so layout rules apply; colors are fixed fills). */
export function fileIconEl(name: string, size = 16): HTMLElement {
  const s = document.createElement('span');
  const spec = fileSpec(name);
  if (!spec) {
    // Unknown type: keep the monochrome outline doc (theme-faint).
    s.className = 'ic fi fi-plain';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/></svg>`;
    return s;
  }
  s.className = 'ic fi';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = render(spec).replace('<svg', `<svg width="${size}" height="${size}"`);
  return s;
}
