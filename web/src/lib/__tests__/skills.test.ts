// Skills subsystem: frontmatter parsing, catalog building, scope merging,
// and the bundled SKILL.md pack shipping with the app.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseSkillMarkdown, parseFrontmatter, skillsCatalog, skillBody,
  mergeSkills, skillsByScope, SKILL_NAME_RE,
} from '../skills';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(here, '..', '..', '..', 'public', 'skills');

describe('parseSkillMarkdown', () => {
  it('parses frontmatter name + description and strips it from the body', () => {
    const sk = parseSkillMarkdown(
      '---\nname: pdf-report\ndescription: Use when generating PDFs.\n---\n\n# Title\n\nBody text.\n',
      { scope: 'project', dir: 'pdf-report' },
    );
    expect(sk).not.toBeNull();
    expect(sk!.name).toBe('pdf-report');
    expect(sk!.description).toBe('Use when generating PDFs.');
    expect(sk!.scope).toBe('project');
    expect(sk!.body).toContain('# Title');
    expect(sk!.body).not.toContain('name: pdf-report');
  });

  it('falls back to the directory name when frontmatter is missing', () => {
    const sk = parseSkillMarkdown('# Just a body\n\nNo frontmatter here.', {
      scope: 'user', dir: 'my-skill',
    });
    expect(sk!.name).toBe('my-skill');
    expect(sk!.description).toBe('');
    expect(sk!.body).toContain('Just a body');
  });

  it('returns null only when there is no usable name at all', () => {
    expect(parseSkillMarkdown('', { scope: 'user', dir: '' })).toBeNull();
  });

  it('tolerates CRLF line endings', () => {
    const sk = parseSkillMarkdown('---\r\nname: crlf-skill\r\ndescription: desc.\r\n---\r\n\r\nBody\r\n', {
      scope: 'user', dir: 'crlf-skill',
    });
    expect(sk!.name).toBe('crlf-skill');
    expect(sk!.description).toBe('desc.');
    expect(sk!.body).toContain('Body');
  });

  it('unquotes quoted frontmatter values', () => {
    const fm = parseFrontmatter('name: "quoted-name"\ndescription: \'single\'');
    expect(fm.name).toBe('quoted-name');
    expect(fm.description).toBe('single');
  });
});

describe('skillsCatalog', () => {
  it('renders one line per skill with name + description', () => {
    const cat = skillsCatalog([
      { name: 'a', description: 'First.', scope: 'user', dir: 'a', path: '', file: '', size: 0 },
      { name: 'b', description: '', scope: 'user', dir: 'b', path: '', file: '', size: 0 },
    ]);
    expect(cat).toContain('## Available Skills');
    expect(cat).toContain('- a: First.');
    expect(cat).toContain('- b: No description.');
  });

  it('is empty when there are no skills', () => {
    expect(skillsCatalog([])).toBe('');
  });
});

describe('skillBody', () => {
  it('renders a loadable body with a heading', () => {
    const body = skillBody({
      name: 'x', description: '', scope: 'user', dir: 'x', path: '', file: '', size: 0, body: 'Do the thing.',
    } as never);
    expect(body).toContain('# Skill: x');
    expect(body).toContain('Do the thing.');
  });
});

describe('mergeSkills', () => {
  it('lets later scopes override earlier ones by name', () => {
    const merged = mergeSkills(
      [{ name: 'a', description: 'bundled', scope: 'bundled', dir: 'a', path: '', file: '', size: 0 }],
      [{ name: 'a', description: 'project wins', scope: 'project', dir: 'a', path: '', file: '', size: 0 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('project wins');
    expect(merged[0].scope).toBe('project');
  });

  it('sorts by name', () => {
    const merged = mergeSkills(
      [{ name: 'z', description: '', scope: 'user', dir: 'z', path: '', file: '', size: 0 }],
      [{ name: 'a', description: '', scope: 'user', dir: 'a', path: '', file: '', size: 0 }],
    );
    expect(merged.map((s) => s.name)).toEqual(['a', 'z']);
  });
});

describe('skillsByScope', () => {
  it('groups skills by scope', () => {
    const grouped = skillsByScope([
      { name: 'b', description: '', scope: 'bundled', dir: 'b', path: '', file: '', size: 0 },
      { name: 'u', description: '', scope: 'user', dir: 'u', path: '', file: '', size: 0 },
      { name: 'p', description: '', scope: 'project', dir: 'p', path: '', file: '', size: 0 },
    ] as never);
    expect(grouped.bundled.map((s) => s.name)).toEqual(['b']);
    expect(grouped.user.map((s) => s.name)).toEqual(['u']);
    expect(grouped.project.map((s) => s.name)).toEqual(['p']);
  });
});

describe('SKILL_NAME_RE', () => {
  it('accepts kebab-case slugs', () => {
    expect(SKILL_NAME_RE.test('pdf-report')).toBe(true);
    expect(SKILL_NAME_RE.test('a')).toBe(true);
    expect(SKILL_NAME_RE.test('a-b-c-123')).toBe(true);
  });
  it('rejects bad slugs', () => {
    expect(SKILL_NAME_RE.test('Bad_Name')).toBe(false);
    expect(SKILL_NAME_RE.test('-leading')).toBe(false);
    expect(SKILL_NAME_RE.test('has space')).toBe(false);
  });
});

describe('bundled skill pack', () => {
  it('ships at least one SKILL.md per expected skill', () => {
    expect(existsSync(skillsRoot)).toBe(true);
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.length).toBeGreaterThanOrEqual(10);
    for (const dir of dirs) {
      const file = path.join(skillsRoot, dir, 'SKILL.md');
      expect(existsSync(file), `${dir}/SKILL.md missing`).toBe(true);
      const text = readFileSync(file, 'utf8');
      const sk = parseSkillMarkdown(text, { scope: 'bundled', dir });
      expect(sk, `${dir} unparseable`).not.toBeNull();
      expect(sk!.name).toBe(dir);
      expect(sk!.description.length, `${dir} description too short`).toBeGreaterThan(10);
      expect(SKILL_NAME_RE.test(sk!.name), `${dir} bad name`).toBe(true);
    }
  });

  it('includes the Qoder-parity skills', () => {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const expected of [
      'skill-creator', 'imagegen', 'canvas', 'find-extensions', 'office-docx',
      'office-excel', 'office-pptx', 'qmind', 'repowiki', 'sites',
      'collaboration', 'qoder-helper',
    ]) {
      expect(dirs, `missing bundled skill: ${expected}`).toContain(expected);
    }
  });
});