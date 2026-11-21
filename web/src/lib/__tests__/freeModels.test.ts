// Free-model classification + the "Free Kilo Code models only" filter.
//
// Regression 1: the old heuristic matched family-name substrings (nemotron,
// muse-spark, gemini-flash-lite, gemma-, "free") anywhere in the ID, so paid
// variants like `nvidia/nemotron-3.5-super-vl` (no `:free`) leaked into the
// "free only" list.
//
// Regression 2: an allowlist guessed `meta/muse-*` and `google/gemini-flash-lite`
// were free, but Kilo reports them isFree:false (paid). The fix prefers Kilo's
// authoritative per-model `isFree` flag, falling back to the explicit `:free`
// suffix only.
import { describe, expect, it } from 'vitest';
import { isFreeModel, isFreeKiloModel, pickDefaultModel } from '../agent';

describe('isFreeModel — ID-only fallback (explicit :free only)', () => {
  it('treats the Kilo free router as free', () => {
    expect(isFreeModel('kilo', 'kilo-auto/free')).toBe(true);
  });

  it('treats any :free suffix as free', () => {
    expect(isFreeModel('kilo', 'nvidia/nemotron-3.5-super-vl:free')).toBe(true);
    expect(isFreeModel('openrouter', 'anthropic/claude-3.5-sonnet:free')).toBe(true);
    expect(isFreeModel('kilo', 'baidu/ernie-5.5-flash-preview:free')).toBe(true);
  });

  it('does NOT mark paid variants free (no :free suffix)', () => {
    expect(isFreeModel('kilo', 'nvidia/nemotron-3.5-super-vl')).toBe(false);
    expect(isFreeModel('kilo', 'meta/muse-spark-open')).toBe(false); // Kilo: isFree:false
    expect(isFreeModel('kilo', 'meta/muse-ember')).toBe(false);
    expect(isFreeModel('kilo', 'google/gemini-flash-lite')).toBe(false);
    expect(isFreeModel('kilo', 'google/gemini-4-neon')).toBe(false);
  });

  it('does NOT mark paid frontier models free', () => {
    expect(isFreeModel('kilo', 'anthropic/claude-opus-5.5')).toBe(false);
    expect(isFreeModel('kilo', 'openai/gpt-6.2-sol')).toBe(false);
    expect(isFreeModel('kilo', 'kilo-auto/efficient')).toBe(false);
  });
});

describe('isFreeKiloModel — prefers the authoritative isFree flag', () => {
  it('uses isFree:true even without a :free suffix', () => {
    // Hypothetical: a model Kilo marks free but whose ID has no :free suffix.
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'meta/muse-spark-open', isFree: true })).toBe(true);
  });

  it('uses isFree:false even WITH a :free-looking name (flag wins)', () => {
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'meta/muse-spark-open:free', isFree: false })).toBe(false);
  });

  it('falls back to :free suffix when the flag is absent', () => {
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'nvidia/nemotron-3.5-super-vl:free' })).toBe(true);
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'nvidia/nemotron-3.5-super-vl' })).toBe(false);
  });

  it('requires the kilo provider', () => {
    expect(isFreeKiloModel({ providerID: 'openrouter', modelID: 'x/y:free' })).toBe(false);
  });

  it('meta/muse-* is NOT free per Kilo metadata (the reported leak)', () => {
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'meta/muse-spark-open', isFree: false })).toBe(false);
    expect(isFreeKiloModel({ providerID: 'kilo', modelID: 'meta/muse-ember', isFree: false })).toBe(false);
  });
});

describe('pickDefaultModel — prefers isFree flag', () => {
  it('picks kilo-auto/free when flagged free', () => {
    const models = [
      { providerID: 'kilo', modelID: 'kilo-auto/free', isFree: true },
      { providerID: 'kilo', modelID: 'anthropic/claude-opus-5.5', isFree: false },
      { providerID: 'kilo', modelID: 'meta/muse-spark-open', isFree: false },
    ];
    expect(pickDefaultModel(models)).toEqual({ providerID: 'kilo', modelID: 'kilo-auto/free' });
  });

  it('returns null when no free model exists', () => {
    const models = [
      { providerID: 'kilo', modelID: 'anthropic/claude-opus-5.5', isFree: false },
      { providerID: 'kilo', modelID: 'meta/muse-spark-open', isFree: false },
    ];
    expect(pickDefaultModel(models)).toBeNull();
  });

  it('respects isFree:false even for a :free-suffixed id', () => {
    const models = [{ providerID: 'kilo', modelID: 'x/y:free', isFree: false }];
    expect(pickDefaultModel(models)).toBeNull();
  });
});