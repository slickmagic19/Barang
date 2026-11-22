// Busy-heartbeat: proves the UI clears "busy" once the server reports idle,
// even when no further event arrives (the reported "done but still working").
//
// Mocks the desktop bridge (window.barang.oc) so refreshStatus/refreshActive
// read a controllable server state.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

type GetFn = (path: string, opts?: unknown) => Promise<unknown>;

function installBridge(get: GetFn) {
  (globalThis as unknown as { window: unknown }).window = {
    barang: {
      // The bridge exposes oc(path, opts) as a function (see transport.ts).
      oc: vi.fn(async (path: string, opts?: unknown) => {
        const method = (opts as { method?: string } | undefined)?.method;
        if (method && method !== 'GET') return {};
        return get(path, opts);
      }),
      events: { onConn: vi.fn(), subscribe: vi.fn() },
    },
  };
}

describe('busy heartbeat (pollStatusOnce)', () => {
  beforeEach(() => {
    // Fresh module state per test via dynamic import reset.
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('clears busy when the server reports idle (no status entry)', async () => {
    // /session/status → {} means the session entry was deleted (run ended).
    installBridge(async (path) => {
      if (path === '/session/status') return {};
      if (path.includes('/message')) return [];
      if (path.includes('/todo')) return [];
      return [];
    });

    const { agentStore, pollStatusOnce } = await import('../agent');
    agentStore.set({ busy: true, status: 'busy', activeId: 'ses_1', messages: [], todos: [] });
    expect(agentStore.get().busy).toBe(true);

    await pollStatusOnce();

    expect(agentStore.get().busy).toBe(false);
    expect(agentStore.get().status).toBe('idle');
  });

  it('stays busy while the server still reports a busy run', async () => {
    installBridge(async (path) => {
      if (path === '/session/status') return { ses_1: { type: 'busy' } };
      return [];
    });

    const { agentStore, pollStatusOnce } = await import('../agent');
    agentStore.set({ busy: true, status: 'busy', activeId: 'ses_1', messages: [], todos: [] });

    await pollStatusOnce();

    expect(agentStore.get().busy).toBe(true);
  });

  it('does nothing when idle (no active session)', async () => {
    installBridge(async (path) => {
      if (path === '/session/status') return {};
      return [];
    });

    const { agentStore, pollStatusOnce } = await import('../agent');
    agentStore.set({ busy: false, activeId: null, messages: [], todos: [] });

    await pollStatusOnce();

    expect(agentStore.get().busy).toBe(false);
  });

  it('when the run just ended, also refreshes messages (final snapshot)', async () => {
    const finalMsg = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'PONG' }] },
    ];
    installBridge(async (path) => {
      if (path === '/session/status') return {}; // idle
      if (path.includes('/message')) return finalMsg;
      if (path.includes('/todo')) return [];
      return [];
    });

    const { agentStore, pollStatusOnce } = await import('../agent');
    agentStore.set({ busy: true, status: 'busy', activeId: 'ses_1', messages: [], todos: [] });

    await pollStatusOnce();

    expect(agentStore.get().busy).toBe(false);
    expect(agentStore.get().messages).toHaveLength(1);
  });

  it('surfaceRetry keeps busy (server says retry)', async () => {
    installBridge(async (path) => {
      if (path === '/session/status') return { ses_1: { type: 'retry', attempt: 2 } };
      return [];
    });

    const { agentStore, pollStatusOnce } = await import('../agent');
    agentStore.set({ busy: true, status: 'busy', activeId: 'ses_1', messages: [], todos: [] });

    await pollStatusOnce();

    expect(agentStore.get().busy).toBe(true);
    expect(agentStore.get().status).toBe('retry');
  });
});