import { describe, expect, it } from 'vitest';
import { statusTextFor } from '../agentStatus';
import { appendLogged, logTranscriptError, shouldKeepPolling } from '../agent';

describe('appendLogged — session transcript log', () => {
  it('appends new entries', () => {
    expect(appendLogged([], 'boom')).toEqual(['boom']);
    expect(appendLogged(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('collapses consecutive duplicates', () => {
    const first = appendLogged([], 'boom');
    expect(appendLogged(first, 'boom')).toBe(first);
  });

  it('keeps only the tail up to the cap', () => {
    const many = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const out = appendLogged(many, 'last', 20);
    expect(out).toHaveLength(20);
    expect(out[out.length - 1]).toBe('last');
    expect(out).not.toContain('e0');
  });
});

describe('logTranscriptError — anchored session errors', () => {
  it('anchors each failure to the message it followed', () => {
    const out = logTranscriptError([], 'boom', 'msg_1');
    expect(out).toEqual([{ text: 'boom', afterId: 'msg_1' }]);
  });

  it('allows a null anchor (failure before any message)', () => {
    expect(logTranscriptError([], 'boom', null)).toEqual([{ text: 'boom', afterId: null }]);
  });

  it('collapses consecutive duplicate texts', () => {
    const first = logTranscriptError([], 'boom', 'msg_1');
    expect(logTranscriptError(first, 'boom', 'msg_2')).toBe(first);
  });
});

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
