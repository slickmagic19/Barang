// Memory subsystem: parsing, serialization round-trips, MEMORY.md index
// maintenance, prompt-block building, and input validation.
import { describe, expect, it } from 'vitest';
import {
  parseMemoryMarkdown, parseFrontmatter, serializeMemory, renderMemoryIndex,
  upsertIndexLine, removeIndexLine, memoryPromptBlock, mergeMemories,
  validateMemoryInput, MEMORY_SLUG_RE,
} from '../memory';

const entry = (over: Partial<Parameters<typeof serializeMemory>[0]> = {}) => ({
  slug: 'user-role',
  title: 'User role',
  hook: 'A software engineer who values direct answers.',
  type: 'user' as const,
  scope: 'user' as const,
  body: 'The user is a software engineer.\nThey value direct, concise answers.',
  ...over,
});

describe('parseMemoryMarkdown', () => {
  it('parses frontmatter + body', () => {
    const md = serializeMemory(entry());
    const e = parseMemoryMarkdown(md, { slug: 'user-role', scope: 'user', file: 'x', mtime: 123 });
    expect(e).not.toBeNull();
    expect(e!.slug).toBe('user-role');
    expect(e!.title).toBe('User role');
    expect(e!.type).toBe('user');
    expect(e!.scope).toBe('user');
    expect(e!.body).toContain('software engineer');
    expect(e!.mtime).toBe(123);
  });

  it('falls back title to slug and hook to the first body line', () => {
    const e = parseMemoryMarkdown('Just a body line.\n\nMore.', { slug: 'my-note', scope: 'project' });
    expect(e!.title).toBe('my-note');
    expect(e!.hook).toBe('Just a body line.');
    expect(e!.type).toBe('project');
  });

  it('returns null for an empty slug', () => {
    expect(parseMemoryMarkdown('body', { slug: '', scope: 'user' })).toBeNull();
  });

  it('tolerates CRLF', () => {
    const e = parseMemoryMarkdown('---\r\nname: x\r\ntitle: "X"\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\nBody\r\n', {
      slug: 'x', scope: 'user',
    });
    expect(e!.title).toBe('X');
    expect(e!.type).toBe('feedback');
  });
});

describe('serializeMemory', () => {
  it('round-trips through parseMemoryMarkdown', () => {
    const md = serializeMemory(entry());
    const e = parseMemoryMarkdown(md, { slug: 'user-role', scope: 'user' });
    expect(e!.body).toBe(entry().body);
    expect(e!.title).toBe('User role');
    expect(e!.hook).toBe(entry().hook);
  });

  it('emits metadata.type', () => {
    const md = serializeMemory(entry({ type: 'reference' }));
    expect(md).toContain('type: reference');
  });
});

describe('renderMemoryIndex', () => {
  it('renders one line per entry, sorted by type then title', () => {
    const idx = renderMemoryIndex([
      { slug: 'b', title: 'B', hook: 'hook b', type: 'project', scope: 'project', body: '', file: '', mtime: 0 },
      { slug: 'a', title: 'A', hook: 'hook a', type: 'user', scope: 'user', body: '', file: '', mtime: 0 },
    ]);
    expect(idx).toContain('# Memory Index');
    expect(idx).toContain('- [A](a.md) — hook a');
    expect(idx).toContain('- [B](b.md) — hook b');
    // user (first in order) before project
    expect(idx.indexOf('[A]')).toBeLessThan(idx.indexOf('[B]'));
  });

  it('never includes memory bodies', () => {
    const idx = renderMemoryIndex([
      { slug: 'a', title: 'A', hook: 'h', type: 'user', scope: 'user', body: 'SECRET BODY', file: '', mtime: 0 },
    ]);
    expect(idx).not.toContain('SECRET BODY');
  });
});

describe('upsertIndexLine', () => {
  it('appends when missing', () => {
    const out = upsertIndexLine('# Memory Index\n', { slug: 'a', title: 'A', hook: 'h' });
    expect(out).toContain('- [A](a.md) — h');
  });

  it('updates an existing line in place', () => {
    const idx = '# Memory Index\n\n- [A](a.md) — old\n';
    const out = upsertIndexLine(idx, { slug: 'a', title: 'A2', hook: 'new' });
    expect(out).toContain('- [A2](a.md) — new');
    expect(out).not.toContain('old');
  });

  it('escapes regex-special slugs safely', () => {
    const out = upsertIndexLine('- [X](a+b.md) — old\n', { slug: 'a+b', title: 'X', hook: 'new' });
    expect(out).toContain('new');
  });
});

describe('removeIndexLine', () => {
  it('removes the matching line', () => {
    const idx = '# Memory Index\n\n- [A](a.md) — h\n- [B](b.md) — h\n';
    const out = removeIndexLine(idx, 'a');
    expect(out).not.toContain('(a.md)');
    expect(out).toContain('(b.md)');
  });
});

describe('memoryPromptBlock', () => {
  const mk = (slug: string, body: string, mtime: number, title = slug) => ({
    slug, title, hook: '', type: 'project' as const, scope: 'project' as const, body, file: '', mtime,
  });

  it('includes entry bodies with headings', () => {
    const block = memoryPromptBlock([mk('a', 'Body A.', 1)]);
    expect(block).toContain('## Memory');
    expect(block).toContain('### a (project/project)');
    expect(block).toContain('Body A.');
  });

  it('tells the agent memory is maintained automatically (no manual files)', () => {
    const block = memoryPromptBlock([mk('a', 'Body A.', 1)]);
    expect(block).toContain('maintains this memory automatically');
    expect(block).toContain('do not create memory files');
  });

  it('sorts newest first and respects maxEntries', () => {
    const block = memoryPromptBlock([mk('old', 'Old.', 1), mk('new', 'New.', 2)], { maxEntries: 1 });
    expect(block).toContain('New.');
    expect(block).not.toContain('Old.');
  });

  it('truncates to maxChars', () => {
    const big = 'x'.repeat(5000);
    const block = memoryPromptBlock([mk('big', big, 1)], { maxChars: 200 });
    expect(block.length).toBeLessThan(400);
    expect(block).toContain('…');
  });

  it('is empty when there are no memories', () => {
    expect(memoryPromptBlock([])).toBe('');
  });
});

describe('mergeMemories', () => {
  it('keeps the newer mtime per slug', () => {
    const merged = mergeMemories(
      [{ slug: 'a', title: 'A', hook: '', type: 'user', scope: 'user', body: 'old', file: '', mtime: 1 }],
      [{ slug: 'a', title: 'A', hook: '', type: 'user', scope: 'user', body: 'new', file: '', mtime: 2 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('new');
  });
});

describe('validateMemoryInput', () => {
  it('accepts a valid entry', () => {
    expect(validateMemoryInput({ slug: 'user-role', title: 'Role', body: 'Body', type: 'user' })).toEqual([]);
  });
  it('flags bad slugs, missing title/body, and bad types', () => {
    const errs = validateMemoryInput({ slug: 'Bad Slug', title: '', body: '', type: 'nope' });
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('MEMORY_SLUG_RE', () => {
  it('accepts kebab-case and rejects the rest', () => {
    expect(MEMORY_SLUG_RE.test('user-role')).toBe(true);
    expect(MEMORY_SLUG_RE.test('x')).toBe(true);
    expect(MEMORY_SLUG_RE.test('Bad')).toBe(false);
    expect(MEMORY_SLUG_RE.test('has space')).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('parses key: value and skips comments', () => {
    const fm = parseFrontmatter('# comment\nname: x\ndescription: hello world');
    expect(fm.name).toBe('x');
    expect(fm.description).toBe('hello world');
  });
});