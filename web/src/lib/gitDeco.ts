// Git decoration model shared by the Source Control view and the explorer:
// one status letter per file, plus a rolled-up change count per folder.
// Pure — no DOM, no IPC (unit-tested in lib/__tests__/gitDeco.test.ts).

export interface GitFileStatus {
  path: string;
  work?: string;
  index?: string;
}

/** VSCode letter for a porcelain status code ('?' untracked renders as 'U'). */
export function letterOf(code: string | undefined | null): string {
  const c = String(code ?? '').trim();
  if (!c) return '';
  return c === '?' ? 'U' : c;
}

/** Winning code for a file row: the worktree side, else the staged side. */
export function codeOf(f: GitFileStatus): string {
  const work = f.work && f.work !== ' ' ? f.work : f.index;
  return letterOf(work);
}

/** Folder of a project-relative path ('.' for top-level files). */
export function dirOf(path: string): string {
  const p = String(path ?? '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i) || '.';
}

/** Every ancestor folder of a path, nearest first, ending at the root ('.'). */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let dir = dirOf(path);
  while (true) {
    out.push(dir);
    if (dir === '.') return out;
    dir = dirOf(dir);
  }
}

export interface Decorations {
  files: Map<string, string>; // project-relative path -> status letter
  dirs: Map<string, number>; // folder -> changed files underneath it
}

/** Build both maps in one pass over the worktree status list. */
export function buildDecorations(list: readonly GitFileStatus[]): Decorations {
  const files = new Map<string, string>();
  const dirs = new Map<string, number>();
  for (const f of list ?? []) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    const letter = codeOf(f);
    if (!letter) continue;
    files.set(f.path, letter);
    for (const dir of ancestorsOf(f.path)) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  return { files, dirs };
}
