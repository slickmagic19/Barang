// Post-turn memory extraction: pure helpers (candidate normalization,
// response parsing, turn slicing, dedupe formatting). The network half is
// exercised by the main-process smoke checks.
import { describe, expect, it } from 'vitest';
import {
  buildExtractionPrompt, conversationSlice, formatExisting,
  normalizeCandidate, parseExtractionResponse,
  type ExtractionMessage,
} from '../memoryExtraction';
import { serializeMemory } from '../memory';

const msg = (role: string, text: string, extra: Record<string, unknown> = {}): ExtractionMessage => ({
  info: { role, ...extra },
  parts: [{ type: 'text', text }],
});

describe('normalizeCandidate', () => {
  it('accepts a well-formed candidate', () => {
    const c = normalizeCandidate({
      slug: 'user-role', title: 'User role', hook: 'Prefers TypeScript',
      type: 'user', scope: 'user', body: 'The user prefers TypeScript.',
    });
    expect(c).toMatchObject({
      slug: 'user-role', title: 'User role', type: 'user', scope: 'user',
      hook: 'Prefers TypeScript',
    });
  });

  it('kebab-cases a messy slug', () => {
    const c = normalizeCandidate({ slug: 'User Role!', title: 'T', body: 'B' });
    expect(c?.slug).toBe('user-role');
  });

  it('defaults type to project and scope to project', () => {
    const c = normalizeCandidate({ slug: 'a-b', title: 'T', body: 'B', type: 'nonsense' });
    expect(c?.type).toBe('project');
    expect(c?.scope).toBe('project');
  });

  it('rejects invalid slugs and empty bodies', () => {
    expect(normalizeCandidate({ slug: '!!!', title: 'T', body: 'B' })).toBeNull();
    expect(normalizeCandidate({ slug: 'ok-slug', title: 'T', body: '   ' })).toBeNull();
    expect(normalizeCandidate(null)).toBeNull();
    expect(normalizeCandidate([])).toBeNull();
  });

  it('derives the hook from the body when missing', () => {
    const c = normalizeCandidate({ slug: 'a-b', title: 'T', body: 'First line here.\nSecond.' });
    expect(c?.hook).toBe('First line here.');
  });
});

describe('parseExtractionResponse', () => {
  it('returns [] for NO_MEMORY', () => {
    expect(parseExtractionResponse('NO_MEMORY')).toEqual([]);
    expect(parseExtractionResponse('  NO_MEMORY  ')).toEqual([]);
    expect(parseExtractionResponse('')).toEqual([]);
  });

  it('parses a bare JSON array', () => {
    const out = parseExtractionResponse(
      '[{"slug":"user-role","title":"Role","body":"Dev."}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('user-role');
  });

  it('tolerates code fences and surrounding prose', () => {
    const out = parseExtractionResponse(
      'Sure!\n```json\n[{"slug":"ui-pref","title":"UI","body":"Dark mode."}]\n```\nDone.',
    );
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('ui-pref');
  });

  it('drops invalid entries and caps at 3', () => {
    const out = parseExtractionResponse(JSON.stringify([
      { slug: 'a-one', title: 'A', body: 'A.' },
      { slug: '!!!', title: 'B', body: 'B.' },
      { slug: 'c-three', title: 'C', body: 'C.' },
      { slug: 'd-four', title: 'D', body: 'D.' },
      { slug: 'e-five', title: 'E', body: 'E.' },
    ]));
    expect(out.map((c) => c.slug)).toEqual(['a-one', 'c-three', 'd-four']);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseExtractionResponse('[{not json')).toEqual([]);
  });
});

describe('conversationSlice', () => {
  it('joins the last user and assistant exchange', () => {
    const s = conversationSlice([
      msg('user', 'old question'),
      msg('assistant', 'old answer'),
      msg('user', 'I always ship with vitest, remember that for every project. Keep tests fast and focused on contracts.'),
      msg('assistant', 'Noted — vitest it is for this project, with contract-style tests where they earn their keep.'),
    ]);
    expect(s).toContain('User: I always ship with vitest');
    expect(s).toContain('Assistant: Noted');
    expect(s).not.toContain('old question');
  });

  it('uses the last text part within a message', () => {
    const s = conversationSlice([
      msg('user', 'x'.repeat(200)),
      { info: { role: 'assistant' }, parts: [{ type: 'tool' }, { type: 'text', text: 'final words here' }] },
    ]);
    expect(s).toContain('Assistant: final words here');
  });

  it('returns null for too-short turns', () => {
    expect(conversationSlice([msg('user', 'hi'), msg('assistant', 'hello')])).toBeNull();
  });

  it('returns null when the assistant turn errored', () => {
    const s = conversationSlice([
      msg('user', 'x'.repeat(200)),
      msg('assistant', 'y'.repeat(200), { error: { message: 'boom' } }),
    ]);
    expect(s).toBeNull();
  });

  it('caps the slice length', () => {
    const s = conversationSlice([
      msg('user', 'u'.repeat(5000)),
      msg('assistant', 'a'.repeat(5000)),
    ], 300);
    expect(s).toHaveLength(300);
  });
});

describe('buildExtractionPrompt', () => {
  it('embeds existing memories and the conversation', () => {
    const p = buildExtractionPrompt('User: hi\n\nAssistant: hello', '- [x] (user/user) X');
    expect(p).toContain('NO_MEMORY');
    expect(p).toContain('- [x] (user/user) X');
    expect(p).toContain('User: hi');
  });
});

describe('formatExisting', () => {
  it('renders one dedupe line per parseable memory', () => {
    const text = serializeMemory({
      slug: 'user-role', title: 'User role', hook: 'Prefers TS',
      type: 'user', scope: 'user', body: 'Body.',
    });
    const out = formatExisting([
      { scope: 'user', slug: 'user-role', text },
      { scope: 'project', slug: 'project-dead', text: null },
    ]);
    expect(out).toContain('[user-role] (user/user) User role — Prefers TS');
    expect(out.split('\n')).toHaveLength(1);
  });
});
