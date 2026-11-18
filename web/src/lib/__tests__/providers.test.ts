import { describe, expect, it } from 'vitest';
import {
  listProviderEntries,
  migrateLegacyProviders,
  removeProviderEntry,
  setProviderEntry,
  type CustomProviderEntry,
} from '../providers';

const ENTRY: CustomProviderEntry = {
  id: 'my-llm',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: ['a/b', 'c-d'],
};

describe('setProviderEntry', () => {
  it('writes the map under Kilo\'s singular `provider` key', () => {
    const out = JSON.parse(setProviderEntry('', ENTRY));
    expect(out.provider['my-llm'].options.baseURL).toBe('https://api.example.com/v1');
    expect(out.provider['my-llm'].npm).toBe('@ai-sdk/openai-compatible');
    expect(Object.keys(out.provider['my-llm'].models)).toEqual(['a/b', 'c-d']);
    expect(out.providers).toBeUndefined();
    expect(out.$schema).toBe('https://app.kilo.ai/config.json');
  });

  it('keeps every other key (mcp servers survive)', () => {
    const prev = JSON.stringify({ mcp: { x: { type: 'remote', url: 'https://x' } } });
    const out = JSON.parse(setProviderEntry(prev, ENTRY));
    expect(out.mcp.x.url).toBe('https://x');
    expect(out.provider['my-llm']).toBeTruthy();
  });

  it('migrates a legacy plural `providers` block instead of dropping it', () => {
    const prev = JSON.stringify({
      providers: { old: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://old/v1' }, models: { m: {} } } },
    });
    const out = JSON.parse(setProviderEntry(prev, ENTRY));
    expect(out.providers).toBeUndefined();
    expect(Object.keys(out.provider).sort()).toEqual(['my-llm', 'old']);
    expect(out.provider.old.options.baseURL).toBe('https://old/v1');
  });

  it('rejects an invalid entry without touching the file', () => {
    expect(() => setProviderEntry('', { ...ENTRY, id: 'Bad Id' })).toThrow(/ID:/);
  });
});

describe('removeProviderEntry', () => {
  it('drops one provider and drops the legacy key', () => {
    const prev = JSON.stringify({
      providers: { legacy: { options: {}, models: {} } },
      provider: { keep: { options: {}, models: {} } },
    });
    const out = JSON.parse(removeProviderEntry(prev, 'keep'));
    expect(out.providers).toBeUndefined();
    expect(out.provider).toEqual({ legacy: { options: {}, models: {} } });
  });
});

describe('listProviderEntries', () => {
  it('reads the singular key', () => {
    const list = listProviderEntries(setProviderEntry('', ENTRY));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'my-llm', baseURL: 'https://api.example.com/v1', keyKind: 'value', models: ['a/b', 'c-d'] });
  });

  it('still lists legacy plural entries (pre-fix files)', () => {
    const prev = JSON.stringify({ providers: { old: { options: { baseURL: 'https://old/v1', apiKey: '{env:OLD_KEY}' }, models: { m: {} } } } });
    const list = listProviderEntries(prev);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'old', keyKind: 'env', models: ['m'] });
  });

  it('returns [] on garbage instead of throwing', () => {
    expect(listProviderEntries('not json')).toEqual([]);
  });
});

describe('migrateLegacyProviders', () => {
  it('rewrites a legacy plural block under the singular key', () => {
    const prev = JSON.stringify({ providers: { old: { options: { baseURL: 'https://old/v1' }, models: { m: {} } } } });
    const out = migrateLegacyProviders(prev);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(String(out));
    expect(parsed.providers).toBeUndefined();
    expect(parsed.provider.old.options.baseURL).toBe('https://old/v1');
  });

  it('returns null when there is nothing to migrate', () => {
    expect(migrateLegacyProviders('')).toBeNull();
    expect(migrateLegacyProviders(setProviderEntry('', ENTRY))).toBeNull();
    expect(migrateLegacyProviders('{"mcp":{}}')).toBeNull();
  });
});
