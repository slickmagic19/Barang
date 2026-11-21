// Usage aggregation (Settings > Usage). Pure logic: sums cost/tokens across
// sessions and builds a per-model breakdown sorted by cost desc.
import { describe, expect, it } from 'vitest';
import { aggregateUsage } from '../agent';

const sess = (over: Record<string, unknown>) => ({
  id: 'ses_x', cost: 0, tokens: {}, model: { id: 'kilo/kilo-auto/free' }, ...over,
});

describe('aggregateUsage', () => {
  it('returns empty totals for no sessions', () => {
    const t = aggregateUsage([]);
    expect(t.sessions).toBe(0);
    expect(t.cost).toBe(0);
    expect(t.tokens).toBe(0);
    expect(t.byModel).toEqual([]);
  });

  it('skips sessions with no usage', () => {
    const t = aggregateUsage([sess({}), null, undefined]);
    expect(t.sessions).toBe(0);
  });

  it('sums tokens and cost across sessions', () => {
    const t = aggregateUsage([
      sess({ cost: 1.5, tokens: { input: 1000, output: 200, reasoning: 50 } }),
      sess({ cost: 0.25, tokens: { input: 500, output: 100 } }),
    ]);
    expect(t.sessions).toBe(2);
    expect(t.cost).toBe(1.75);
    expect(t.input).toBe(1500);
    expect(t.output).toBe(300);
    expect(t.reasoning).toBe(50);
    expect(t.tokens).toBe(1850);
  });

  it('includes cache read/write in the totals', () => {
    const t = aggregateUsage([
      sess({ tokens: { input: 10, cache: { read: 76143104, write: 0 } } }),
    ]);
    expect(t.cacheRead).toBe(76143104);
    expect(t.cacheWrite).toBe(0);
  });

  it('counts a cache-only session', () => {
    const t = aggregateUsage([sess({ tokens: { cache: { read: 5000 } } })]);
    expect(t.sessions).toBe(1);
  });

  it('builds a per-model breakdown sorted by cost desc', () => {
    const t = aggregateUsage([
      sess({ cost: 3, tokens: { input: 100 }, model: { id: 'kilo/anthropic/claude-opus-5.5' } }),
      sess({ cost: 0.5, tokens: { input: 1000 }, model: { id: 'kilo/kilo-auto/free' } }),
      sess({ cost: 3, tokens: { input: 50 }, model: { id: 'kilo/anthropic/claude-opus-5.5' } }),
    ]);
    expect(t.byModel).toHaveLength(2);
    expect(t.byModel[0].model).toBe('kilo/anthropic/claude-opus-5.5');
    expect(t.byModel[0].cost).toBe(6);
    expect(t.byModel[0].sessions).toBe(2);
  });

  it('falls back to "unknown" for a model-less session', () => {
    const t = aggregateUsage([sess({ cost: 1, model: undefined })]);
    expect(t.byModel[0].model).toBe('unknown');
  });
});