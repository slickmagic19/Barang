// Direct client for the owned `opencode serve` instance (no HTTP proxy needed
// inside a desktop app — main fetches upstream with the env auth header and
// returns plain results over IPC). Also pumps the upstream /event SSE bus and
// forwards parsed frames to renderer windows.
import { startOpencodeServer, serverAuthHeader } from './opencode.js';

let server = null; // { base, port, version, cliVersion, stop }
let pumpController = null;
let pumpFailures = 0;
let onFrame = null;
let onConn = null;

export function opencodeState() {
  return server
    ? { running: true, base: server.base, port: server.port, version: server.version, cli: server.cliVersion }
    : { running: false };
}

/** One opencode REST call. Returns { status, text }. GETs retry through cold boot. */
export async function ocCall(path, { method = 'GET', body } = {}) {
  if (!server) throw new Error('opencode server is not running yet');
  const headers = { ...serverAuthHeader() };
  let bodyInit;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyInit = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const retryable = method === 'GET';
  let lastErr = null;
  for (let attempt = 0; attempt < (retryable ? 4 : 1); attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 700));
    try {
      const res = await fetch(server.base + path, { method, headers, body: bodyInit });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('opencode upstream failed: ' + (lastErr?.message || 'unreachable'));
}

/** (Re)start the server rooted at cwd. Restarts the event pump too. */
export async function ensureServer(cwd, { port = 0, onLog = () => {} } = {}) {
  if (server) return server;
  server = await startOpencodeServer({ cwd, port, onLog });
  startPump();
  return server;
}

export function stopServer() {
  stopPump();
  try {
    server?.stop();
  } catch {
    /* noop */
  }
  server = null;
}

/** Change project root: full server restart (serve is rooted at launch). */
export async function restartServer(cwd, opts = {}) {
  stopServer();
  return ensureServer(cwd, opts);
}

function stopPump() {
  try {
    pumpController?.abort();
  } catch {
    /* noop */
  }
  pumpController = null;
}

function startPump() {
  stopPump();
  pumpController = new AbortController();
  void pumpLoop(pumpController.signal);
}

export function attachPumpHandlers({ onFrame: f, onConn: c }) {
  onFrame = f;
  onConn = c;
}

async function pumpLoop(signal) {
  // Slight delay: the server accepts /global/health before all routes stream well.
  await new Promise((r) => setTimeout(r, 1500));
  while (!signal.aborted) {
    try {
      onConn?.(false);
      const res = await fetch(server.base + '/event', { headers: serverAuthHeader(), signal });
      if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
      onConn?.(true);
      pumpFailures = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            /* noop */
          }
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length) onFrame?.(dataLines.join('\n'));
        }
      }
    } catch (e) {
      if (signal.aborted) break;
      pumpFailures++;
      onConn?.(false);
      // Back off: 1s … 10s max. A missing server (restarting roots) just retries.
      await new Promise((r) => setTimeout(r, Math.min(1000 * pumpFailures, 10000)));
    }
  }
}
