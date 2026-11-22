import { describe, expect, it } from 'vitest';
import { statusTextFor } from '../agentStatus';
import { shouldKeepPolling } from '../agent';

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

describe('shouldKeepPolling — busy heartbeat', () => {
  it('polls while busy with an active session', () => {
    expect(shouldKeepPolling({ busy: true, activeId: 'ses_1' }, null)).toBe(true);
  });

  it('does not poll when idle', () => {
    expect(shouldKeepPolling({ busy: false, activeId: 'ses_1' }, null)).toBe(false);
  });

  it('does not poll without an active session', () => {
    expect(shouldKeepPolling({ busy: true, activeId: null }, null)).toBe(false);
  });

  it('does not poll a relay session (the relay poller owns it)', () => {
    expect(shouldKeepPolling({ busy: true, activeId: 'ses_1' }, 'ses_1')).toBe(false);
  });

  it('polls a different session while a relay run is on another session', () => {
    expect(shouldKeepPolling({ busy: true, activeId: 'ses_2' }, 'ses_1')).toBe(true);
  });
});
