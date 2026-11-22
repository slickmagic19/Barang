// Skills backend: discovers SKILL.md files across three scopes and exposes
// read/list operations to the renderer over IPC. Mirrors the pure logic in
// web/src/lib/skills.ts — main only walks the filesystem and returns bytes.
//
// Scopes (Qoder parity):
//   bundled — shipped inside the app (web/dist/skills, copied at build)
//   user    — <userData>/skills (global, all projects)
//   project — <root>/.barang/skills (per project)
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';

/** Resolve the bundled skills directory (packaged or dev checkout). */
export function bundledSkillsDir(appDir) {
  // appDir = electron/main; bundled skills ship under web/dist/skills after
  // the Vite build copies web/public/skills, or web/public/skills in dev.
  const candidates = [
    path.join(appDir, '..', '..', 'web', 'dist', SKILLS_DIR),
    path.join(appDir, '..', '..', 'web', 'public', SKILLS_DIR),
  ];
  return candidates;
}

/** List skill directories under a scope root (skips non-dirs + hidden). */
async function listSkillDirs(scopeRoot) {
  let dirents;
  try {
    dirents = await fs.readdir(scopeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    dirs.push(d.name);
  }
  dirs.sort();
  return dirs;
}

/** Parse one SKILL.md file into the meta shape the renderer expects.
 *  Mirrors parseSkillMarkdown in the renderer (kept in sync by contract
 *  tests) — main returns raw text + path and lets the renderer parse, so
 *  there is a single parser. Here we only read bytes + stat. */
async function readSkillFile(scope, dirName, skillDir) {
  const file = path.join(skillDir, SKILL_FILE);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  return { scope, dir: dirName, path: skillDir, file, text };
}

/** Discover every skill across the three scopes. Returns a flat list of
 *  { scope, dir, path, file, text } — the renderer parses frontmatter. */
export async function discoverSkills({ appDir, userDataDir, root }) {
  const out = [];
  const seen = new Set();
  const push = async (scope, scopeRoot) => {
    if (!scopeRoot) return;
    for (const dirName of await listSkillDirs(scopeRoot)) {
      const skillDir = path.join(scopeRoot, dirName);
      const rec = await readSkillFile(scope, dirName, skillDir).catch(() => null);
      if (!rec) continue;
      const key = `${scope}:${dirName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
  };
  // bundled first (lowest precedence — user/project override by name later)
  for (const dir of bundledSkillsDir(appDir)) {
    await push('bundled', dir);
    // stop at the first existing bundled dir (dist wins over public in dev)
    try {
      await fs.access(dir);
      break;
    } catch {
      /* try next candidate */
    }
  }
  await push('user', path.join(userDataDir, SKILLS_DIR));
  await push('project', root ? path.join(root, '.barang', SKILLS_DIR) : '');
  return out;
}

/** Write a project-scope skill (create or update). `name` must be a safe
 *  directory slug; body is the full SKILL.md text. Returns the file path. */
export async function writeProjectSkill(root, name, text) {
  if (!root) throw new Error('No folder open');
  const dirName = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(dirName)) {
    throw new Error('Bad skill name (lowercase letters, numbers, dashes)');
  }
  const dir = path.join(root, '.barang', SKILLS_DIR, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, SKILL_FILE);
  const prev = await fs.readFile(file, 'utf8').catch(() => null);
  if (prev !== null && prev !== text) {
    await fs.writeFile(file + '.bak', prev).catch(() => {});
  }
  await fs.writeFile(file, String(text ?? ''), 'utf8');
  return file;
}

/** Delete a project-scope skill directory. No-op when missing. */
export async function removeProjectSkill(root, name) {
  if (!root) throw new Error('No folder open');
  const dirName = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(dirName)) {
    throw new Error('Bad skill name');
  }
  const dir = path.join(root, '.barang', SKILLS_DIR, dirName);
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}