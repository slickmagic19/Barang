// Root-confined workspace file operations (called from IPC handlers).
// Same behavior as the original bridge: lazy depth-limited tree, 1MB reads
// with binary sniffing, atomic writes, ripgrep fast-path with fallback.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isWin } from './opencode.js';

const MAX_READ = 1024 * 1024; // 1MB
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '__pycache__', '.venv', 'target', 'bin', 'obj', '.idea', '.vscode', 'release',
]);

function resolveIn(root, rel) {
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes project root');
  return abs;
}

async function listDir(abs, root, depth, includeSkipped) {
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (!includeSkipped && d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
    const full = path.join(abs, d.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    const node = { name: d.name, path: rel, type: d.isDirectory() ? 'dir' : 'file' };
    if (d.isDirectory() && depth > 1) {
      try {
        node.children = await listDir(full, root, depth - 1, includeSkipped);
      } catch {
        node.children = [];
      }
    }
    entries.push(node);
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1,
  );
  return entries;
}

export async function tree(root, { path: rel = '.', depth = 1, all = false } = {}) {
  const abs = resolveIn(root, rel);
  return { path: rel, children: await listDir(abs, root, Math.min(depth, 3), all) };
}

export async function readFile(root, rel) {
  if (!rel) throw new Error('Missing path');
  const abs = resolveIn(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error('Not a file');
  if (stat.size > MAX_READ) throw new Error('File too large to open (>1MB)');
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) return { path: rel, binary: true, size: stat.size };
  return { path: rel, content: buf.toString('utf8'), size: stat.size, mtime: stat.mtimeMs };
}

export async function writeFile(root, rel, content) {
  if (!rel || typeof content !== 'string') throw new Error('Need {path, content}');
  const abs = resolveIn(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + `.barang-tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  const stat = await fs.stat(abs);
  return { ok: true, path: rel, size: stat.size, mtime: stat.mtimeMs };
}

export async function mkdir(root, rel) {
  if (!rel || typeof rel !== 'string') throw new Error('Need {path}');
  const abs = resolveIn(root, rel);
  await fs.mkdir(abs, { recursive: true });
  return { ok: true, path: rel };
}

function fuzzyScore(query, name) {
  query = query.toLowerCase();
  name = name.toLowerCase();
  let qi = 0,
    score = 0,
    last = -1;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (name[i] === query[qi]) {
      score += last === i - 1 ? 3 : 1;
      if (i === 0 || name[i - 1] === '/' || name[i - 1] === '_' || name[i - 1] === '-') score += 2;
      last = i;
      qi++;
    }
  }
  return qi === query.length ? score : -1;
}

async function* walk(root, rel, includeSkipped, maxFiles) {
  let count = 0;
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop();
    const abs = path.join(root, cur);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!includeSkipped && d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
      const childRel = cur ? `${cur}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(childRel);
      else {
        yield childRel;
        if (++count >= maxFiles) return;
      }
    }
  }
}

export async function find(root, { query = '', limit = 50 } = {}) {
  const q = query.trim();
  if (!q) return { results: [] };
  const scored = [];
  for await (const rel of walk(root, '', false, 20000)) {
    const s = fuzzyScore(q, rel);
    if (s >= 0) scored.push({ path: rel, score: s + (rel.length < 60 ? 2 : 0) });
    if (scored.length > 5000) break;
  }
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, Math.min(limit, 200)) };
}

let rgAvailable = null;
function hasRg() {
  if (rgAvailable !== null) return Promise.resolve(rgAvailable);
  return rgBin().then((b) => {
    rgAvailable = !!b;
    return rgAvailable;
  });
}

/**
 * ripgrep resolution: the bundled binary first (works on fresh PCs with no
 * system rg), then the system one. The bundled path is rewritten out of the
 * asar (packed binaries can't execute in place). Direct binary spawn, no
 * shell needed either way once resolved... except the legacy PATH shim on
 * Windows, which still needs a shell.
 */
let _rgBin = null;
async function rgBin() {
  if (_rgBin) return _rgBin;
  try {
    const mod = await import('@vscode/ripgrep');
    let p = mod.rgPath || mod.default?.rgPath || null;
    if (p && p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
      p = p.replace('app.asar', 'app.asar.unpacked');
    }
    if (p) {
      await fs.access(p);
      _rgBin = { cmd: p, shell: false };
      return _rgBin;
    }
  } catch {
    /* not installed — fall through to the system probe */
  }
  _rgBin = { cmd: isWin ? 'rg.exe' : 'rg', shell: isWin, system: true };
  return new Promise((resolve) => {
    execFile(_rgBin.cmd, ['--version'], { shell: _rgBin.shell }, (err) => {
      if (err) _rgBin = null;
      resolve(_rgBin);
    });
  });
}

async function rgSearch(root, query, relDir, limit) {
  const { cmd, shell } = (await rgBin()) ?? {};
  if (!cmd) return { results: [], engine: 'ripgrep', truncated: true };
  return new Promise((resolve) => {
      const args = ['--json', '--max-count', '5', '--max-columns', '200', '-i', '--hidden', '--glob', '!.git', query];
    if (relDir) args.push(relDir);
    else args.push('.'); // no path arg = stdin wait (hang!) — always scope explicitly
    execFile(cmd, args, { cwd: root, shell, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = [];
      for (const line of String(stdout || '').split('\n')) {
        if (out.length >= limit) break;
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'match') {
            out.push({
              path: cleanRgPath(ev.data.path.text),
              line: ev.data.line_number,
              text: ev.data.lines.text.trim().slice(0, 240),
            });
          }
        } catch {
          /* skip */
        }
      }
      resolve({ results: out, engine: 'ripgrep', truncated: !!err });
    });
  });
}

async function nodeSearch(root, query, relDir, limit) {
  const out = [];
  let needle;
  try {
    needle = new RegExp(query, 'i');
  } catch {
    needle = null;
  }
  const test = needle
    ? (s) => {
        try {
          return needle.test(s);
        } catch {
          return false;
        }
      }
    : (s) => s.toLowerCase().includes(query.toLowerCase());
  for await (const rel of walk(root, relDir || '', false, 3000)) {
    if (out.length >= limit) break;
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|dll|bin|mp4|woff2?)$/i.test(rel)) continue;
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 5; i++) {
      if (test(lines[i])) {
        out.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
        perFile++;
      }
    }
  }
  return { results: out, engine: 'builtin' };
}

export async function search(root, { q = '', path: relDir = '', limit = 50 } = {}) {
  if (!q) throw new Error('Missing q');
  const n = Math.min(limit, 200);
  if (await hasRg()) return rgSearch(root, q, relDir, n);
  return nodeSearch(root, q, relDir, n);
}

const REPLACE_SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|dll|bin|mp4|mov|woff2?|ttf|otf|wav|mp3|ogg|flac)$/i;
const REPLACE_MAX_FILE = 1024 * 1024; // 1MB (same as reads)
const REPLACE_LIST_CAP = 200; // listed files (counts stay exact)

/** ripgrep prints ./-prefixed paths when scoped to '.' — strip for clean
 *  display and exact prefix matching (include/onlyFiles). */
function cleanRgPath(l) {
  return l.split(path.sep).join('/').replace(/^\.\//, '');
}
const RG_SKIP_GLOBS = ['!.git', '!node_modules', '!.hg', '!.svn', '!dist', '!build', '!out', '!.next', '!__pycache__', '!.venv', '!target', '!bin', '!obj', '!.idea', '!.vscode', '!release'];
const rgSkipArgs = () => RG_SKIP_GLOBS.flatMap((g) => ['--glob', g]);
function listReplaceCandidates(root, relDir) {
  return rgBin().then(({ cmd, shell } = {}) => {
    if (!cmd) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        cmd,
        ['--files', '--hidden', ...rgSkipArgs(), ...(relDir ? [relDir] : ['.'])],
        { cwd: root, shell, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        resolve(
          String(stdout)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map(cleanRgPath),
        );
      },
      );
    });
  });
}

/**
 * Fast pre-filter: files CONTAINING a match (ripgrep -l, C-speed, honors
 * .gitignore). The Node loop below then only stats/reads these instead of
 * every file in the repo. Null = rg missing/failed → full-walk fallback.
 */
function rgFilesWithMatches(root, { pattern, literal, caseSensitive, wholeWord, relDir }) {
  return rgBin().then(({ cmd, shell } = {}) => {
    if (!cmd) return Promise.resolve(null);
    return new Promise((resolve) => {
      const args = ['-l', '--hidden', ...rgSkipArgs()];
      args.push(caseSensitive ? '-s' : '-i');
      if (literal) args.push('-F');
      if (wholeWord) args.push('-w');
    args.push('-e', pattern);
    // No bare path = stdin wait (hang!) — the project root is the scope.
    args.push(relDir || '.');
      execFile(cmd, args, { cwd: root, shell, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // cmd's "not recognized" also exits 1 on Windows — only a CLEAN
          // exit-1 (rg ran, zero hits) means empty; everything else falls back.
          const se = String(stderr || '');
          if (/not recognized|not found|ENOENT|spawning/i.test(se)) return resolve(null);
          if (typeof err.code === 'number' && err.code === 1) return resolve([]);
          return resolve(null);
        }
        resolve(
          String(stdout || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map(cleanRgPath),
        );
      });
    });
  });
}

/**
 * Project-wide search-and-replace. dryRun scans only (for the confirm
 * dialog); apply writes. Literal by default, regex opt-in ($1 groups work
 * in regex mode, literal otherwise). No undo — the confirm dialog says so.
 */
export async function searchReplace(
  root,
  {
    q = '', replacement = '', regex = false, wholeWord = false, caseSensitive = true,
    path: relDir = '', include = [], exclude = [], onlyFiles = null, dryRun = true,
  } = {},
) {
  const query = String(q ?? '');
  if (!query) throw new Error('Empty search text');
  const flags = 'g' + (caseSensitive ? '' : 'i');
  const core = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try {
    re = new RegExp(wholeWord ? `\\b(?:${core})\\b` : core, flags);
  } catch {
    throw new Error(`Invalid regular expression: ${query}`);
  }
  const repl = String(replacement ?? '');
  // Regex mode honors $1 groups (VSCode parity); literal mode never expands $.
  const replacer = regex ? repl : () => repl;
  const normList = (v) => [].concat(v ?? []).map((s) => String(s)).filter(Boolean);
  const includes = normList(include).map((p) => p.replace(/\/+$/, ''));
  const excludes = normList(exclude);
  const only = onlyFiles ? new Set(normList(onlyFiles)) : null;
  // Fast path first: only files that actually match (rg -l). The Node loop
  // below then stats/reads dozens of files instead of tens of thousands.
  // Falls back to the full listing when rg is missing or errors.
  let candidates = null;
  if (await hasRg()) {
    candidates = await rgFilesWithMatches(root, {
      pattern: query, literal: !regex, caseSensitive, wholeWord, relDir,
    });
  }
  if (!candidates) {
    const all = await listReplaceCandidates(root, relDir);
    candidates = all ?? [];
    if (!all) {
      for await (const rel of walk(root, relDir || '', false, 20000)) candidates.push(rel);
    }
  }
  let candidateTruncated = false;
  if (candidates.length > 30000) {
    candidates = candidates.slice(0, 30000);
    candidateTruncated = true;
  }
  const inScope = (rel) => {
    if (only && !only.has(rel)) return false;
    if (includes.length && !includes.some((p) => rel === p || rel.startsWith(p + '/'))) return false;
    if (excludes.some((x) => rel.includes(x))) return false;
    return true;
  };
  const files = [];
  const skipped = [];
  let skippedCount = 0;
  let totalMatches = 0;
  let totalFiles = 0;
  let scannedFiles = 0;
  const details = [];
  let detailTruncated = false;
  for (const rel of candidates) {
    if (!inScope(rel)) continue;
    if (REPLACE_SKIP_EXT.test(rel)) {
      skippedCount++;
      if (skipped.length < 50) skipped.push({ path: rel, reason: 'binary type' });
      continue;
    }
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > REPLACE_MAX_FILE) {
      skippedCount++;
      if (skipped.length < 50) skipped.push({ path: rel, reason: 'too large' });
      continue;
    }
    scannedFiles++;
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) {
      skippedCount++;
      if (skipped.length < 50) skipped.push({ path: rel, reason: 'binary' });
      continue;
    }
    // Line-based matching (rg semantics — patterns never span lines):
    // consistent counts plus [start, len] offset pairs for highlighting.
    const lines = text.split('\n');
    let matches = 0;
    const fileDetails = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      let lineMatches = 0;
      const rawCols = [];
      while ((m = re.exec(lines[i])) !== null) {
        lineMatches++;
        if (rawCols.length < 40) rawCols.push(m.index, m[0].length);
        if (lineMatches > 200) break;
        if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
      }
      if (lineMatches) {
        matches += lineMatches;
        if (details.length < 500) {
          // Preview text is trimmed + sliced — rebase offsets onto THAT, or
          // highlights drift on indented lines and past the slice edge.
          const rawLine = lines[i];
          const lead = rawLine.length - rawLine.trimStart().length;
          const text = rawLine.trim().slice(0, 240);
          const cols = [];
          for (let k = 0; k + 1 < rawCols.length && cols.length < 40; k += 2) {
            let s = rawCols[k] - lead;
            let len = rawCols[k + 1];
            if (s + len <= 0 || s >= 240) continue;
            if (s < 0) {
              len += s;
              s = 0;
            }
            if (s + len > 240) len = 240 - s;
            if (len > 0) cols.push(s, len);
          }
          fileDetails.push({ path: rel, line: i + 1, text, cols });
        } else {
          detailTruncated = true;
        }
      }
    }
    if (!matches) continue;
    totalMatches += matches;
    totalFiles++;
    for (const d of fileDetails) details.push(d);
    if (!dryRun) {
      const next = [];
      for (const ln of lines) {
        re.lastIndex = 0;
        next.push(ln.replace(re, replacer));
      }
      await writeFile(root, rel, next.join('\n'));
    }
    if (files.length < REPLACE_LIST_CAP) files.push({ path: rel, matches });
  }
  return { files, totalMatches, totalFiles, scannedFiles, skipped, skippedCount, details, detailTruncated, candidateTruncated };
}

export async function renamePath(root, from, to) {
  if (!from || !to) throw new Error('Need {from, to}');
  const absFrom = resolveIn(root, from);
  const absTo = resolveIn(root, to);
  if (absFrom === root || absTo === root) throw new Error('Cannot rename the project root');
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
  const rel = path.relative(root, absTo).split(path.sep).join('/');
  return { ok: true, path: rel };
}

export async function removePath(root, rel) {
  if (!rel) throw new Error('Need {path}');
  const abs = resolveIn(root, rel);
  if (abs === root) throw new Error('Cannot delete the project root');
  await fs.rm(abs, { recursive: true, force: true });
  return { ok: true, path: rel };
}

/**
 * Write an absolute path (untitled Save-As only). NOT root-confined by
 * design: the path always comes from the native save dialog, which is
 * explicit user consent for that exact location.
 */
export async function writeAbsolute(absPath, content, root) {
  if (!absPath || !path.isAbsolute(absPath)) throw new Error('Need an absolute {path}');
  if (typeof content !== 'string') throw new Error('Need {content}');
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = absPath + `.barang-tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, absPath);
  const stat = await fs.stat(absPath);
  const fwd = absPath.split(path.sep).join('/');
  let rootRel = null;
  try {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (rel && !rel.startsWith('..')) rootRel = rel;
  } catch { /* outside project */ }
  return { ok: true, path: fwd, rootRel, size: stat.size, mtime: stat.mtimeMs };
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export function mimeFor(name) {
  return IMAGE_MIME[path.extname(String(name || '')).toLowerCase()] || null;
}

export function isImageName(name) {
  return mimeFor(name) !== null;
}

/**
 * Read any absolute file as base64 (for composer image attachments — these
 * live anywhere, e.g. Downloads, so this is intentionally NOT root-confined).
 */
export async function readExternal(absPath, maxBytes = 8 * 1024 * 1024) {
  if (!absPath || !path.isAbsolute(absPath)) throw new Error('Need an absolute {path}');
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error('Not a file');
  if (stat.size > maxBytes) throw new Error(`File too large for attach (${(stat.size / 1048576).toFixed(1)} MB > ${(maxBytes / 1048576).toFixed(0)} MB)`);
  const mime = mimeFor(absPath);
  if (!mime) throw new Error('Only images can be attached as files (PNG, JPG, GIF, WebP, BMP)');
  const buf = await fs.readFile(absPath);
  return { ok: true, path: absPath, name: path.basename(absPath), mime, size: stat.size, base64: buf.toString('base64') };
}
