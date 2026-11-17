import { describe, expect, it } from 'vitest';
import { statusTextFor } from '../agentStatus';

describe('statusTextFor — busy row wording', () => {
  it('keeps the plain working label for a normal run', () => {
    expect(statusTextFor('busy')).toBe('Agent working…');
    expect(statusTextFor('')).toBe('Agent working…');
    // No "(busy)" suffix: the spinner already says the run is in flight.
    expect(statusTextFor('busy')).not.toContain('(');
  });

  it('surfaces a retry and its attempt count', () => {
    expect(statusTextFor('retry')).toBe('Agent retrying…');
    expect(statusTextFor('retry', 3)).toBe('Agent retrying… (attempt 3)');
  });

  it('announces a stopping run', () => {
    expect(statusTextFor('stopping')).toBe('Agent stopping…');
  });
});
