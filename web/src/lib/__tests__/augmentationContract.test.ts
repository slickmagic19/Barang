// Contract: the augmentation helpers that wire skills + memory into the
// agent turn, plus the bridge/settings surface they depend on.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { augmentationBlock, augmentBody } from '../agent';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentTs = readFileSync(path.resolve(here, '..', 'agent.ts'), 'utf8');
const preload = readFileSync(path.resolve(here, '..', '..', '..', '..', 'electron', 'preload.cjs'), 'utf8');

describe('augmentationBlock', () => {
  it('combines the skills catalog and memory block', () => {
    const block = augmentationBlock(
      [{ name: 'pdf', description: 'Use when generating PDFs.', scope: 'user', dir: 'pdf', path: '', file: '', size: 0 }],
      [{ slug: 'user-role', title: 'User role', hook: '', type: 'user', scope: 'user', body: 'Engineer.', file: '', mtime: 1 }],
    );
    expect(block).toContain('## Available Skills');
    expect(block).toContain('- pdf: Use when generating PDFs.');
    expect(block).toContain('## Memory');
    expect(block).toContain('Engineer.');
  });

  it('is empty when both are empty', () => {
    expect(augmentationBlock([], [])).toBe('');
  });

  it('includes only the skills block when there are no memories', () => {
    const block = augmentationBlock(
      [{ name: 'a', description: 'D.', scope: 'user', dir: 'a', path: '', file: '', size: 0 }],
      [],
    );
    expect(block).toContain('## Available Skills');
    expect(block).not.toContain('## Memory');
  });
});

describe('augmentBody', () => {
  it('prepends context and preserves the original message verbatim', () => {
    const out = augmentBody('Fix the bug.', '## Memory\n- something');
    expect(out).toContain('## Memory');
    expect(out).toContain('[User message]');
    expect(out).toContain('Fix the bug.');
    // original text must appear unchanged
    expect(out.endsWith('Fix the bug.')).toBe(true);
  });

  it('returns the body unchanged when there is no augmentation', () => {
    expect(augmentBody('Hello.', '')).toBe('Hello.');
  });

  it('states that memory is client-maintained (no manual memory files)', () => {
    const out = augmentBody('Fix the bug.', '## Memory\n- something');
    expect(out).toContain('maintained automatically by the client');
    expect(out).toContain('never write memory files');
  });
});

describe('agent.ts wiring', () => {
  it('prepends augmentation inside sendMessage before building the payload', () => {
    const idx = agentTs.indexOf('const augmentation = await currentAugmentation(body)');
    expect(idx).toBeGreaterThan(-1);
    const payloadIdx = agentTs.indexOf('const payload = {', idx);
    expect(payloadIdx).toBeGreaterThan(idx);
    expect(agentTs.slice(idx, payloadIdx)).toContain('augmentBody(body, augmentation)');
  });

  it('passes the user text into retrieval for slash commands too', () => {
    expect(agentTs).toContain('const augmentation = await currentAugmentation(`${name} ${args}`)');
    expect(agentTs).toContain('arguments: augmentBody(args, augmentation)');
  });

  it('conditions the repo map on the request text', () => {
    expect(agentTs).toContain('async function currentAugmentation(query = \'\')');
    expect(agentTs).toContain('loadRepoMap(repoQuery)');
    expect(agentTs).toContain('function lastUserQuery()');
    expect(agentTs).toContain('export async function loadRepoMap(query = \'\')');
    expect(agentTs).toContain('const index = await getRepoIndex(root)');
    expect(agentTs).toContain('return index ? buildRepoMap(index, { query }) : \'\'');
  });

  it('guards skills/memory behind settings flags', () => {
    expect(agentTs).toContain('skillsEnabled');
    expect(agentTs).toContain('memoryEnabled');
  });

  it('defines loadSkills and loadMemories', () => {
    expect(agentTs).toContain('export async function loadSkills');
    expect(agentTs).toContain('export async function loadMemories');
  });
});

describe('preload bridge', () => {
  it('exposes skills.list/write/remove', () => {
    expect(preload).toContain("invoke('skills:list')");
    expect(preload).toContain("invoke('skills:write'");
    expect(preload).toContain("invoke('skills:remove'");
  });

  it('exposes memory.discover/write/write-index/remove', () => {
    expect(preload).toContain("invoke('memory:discover')");
    expect(preload).toContain("invoke('memory:write'");
    expect(preload).toContain("invoke('memory:write-index'");
    expect(preload).toContain("invoke('memory:remove'");
  });
});