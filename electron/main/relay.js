// CLI Relay backend: run opencode-provider chats through the official
// `opencode run` CLI (serve-driven Zen free calls are gated upstream; the
// official CLI path passes — verified live). Spawns are shell-free argv
// arrays against the resolved CLI binary, rooted at the open project.
// Runs end when the process ends (or the user stops it) — there is
// deliberately no time cap: long agentic work (installs, dev servers)
// must not be killed mid-flight. One active run is guarded renderer-side;
// main additionally refuses a second concurrent run to avoid duplicate turns.
import { spawn } from 'node:child_process';
import { findOpencode, isDirectBinary, tryStop, isWin } from './opencode.js';

const MAX_STDERR_TAIL = 8192;
const MAX_EVENT_LINES = 400; // forwarded per run (chatty tool streams stay bounded)

const runs = new Map(); // runId -> { child, sessionID, imageDir, done, startedAt }
let seq = 0;

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-+:]{0,199}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]{20,40}$/;
const DATAURL_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/;

function fail(message) {
  throw new Error(message);
}

/** Strict argv build (main is authoritative — renderer pre-validates too).
 *  Returns { argv, staged } where staged lists temp files to clean up. */
async function buildArgv({ message, model, agent, sessionID, title, variant, files, images, auto }) {
  const msg = String(message ?? '');
  if (!msg.trim()) fail('CLI relay needs message text.');
  const providerID = String(model?.providerID ?? '');
  const modelID = String(model?.modelID ?? '');
  if (!PROVIDER_ID_RE.test(providerID)) fail('Bad provider ID for CLI relay.');
  if (!MODEL_ID_RE.test(modelID)) fail('Bad model ID for CLI relay.');
  const argv = ['run', msg, '--format', 'json', '--model', `${providerID}/${modelID}`];
  const ag = String(agent ?? '').trim();
  if (ag) {
    if (!AGENT_RE.test(ag)) fail('Bad agent name for CLI relay.');
    argv.push('--agent', ag);
  }
  const sid = String(sessionID ?? '').trim();
  if (sid) {
    if (!SESSION_ID_RE.test(sid)) fail('Bad session ID for CLI relay.');
    argv.push('--session', sid);
  }
  const t = String(title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (t) argv.push('--title', t);
  const v = String(variant ?? '').trim();
  if (v) {
    if (!AGENT_RE.test(v) || v.length > 32) fail('Bad variant for CLI relay.');
    argv.push('--variant', v);
  }
  const staged = [];
  const seen = new Set();
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const fileList = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f) : [];
  if (fileList.length > 5) fail('CLI relay takes at most 5 files.');
  for (const f of fileList) {
    const abs = path.resolve(String(f));
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st = null;
    try {
      st = await fs.stat(abs);
    } catch {
      fail(`Relay file not found: ${abs.slice(0, 160)}`);
    }
    if (!st.isFile()) fail(`Relay file is not a file: ${abs.slice(0, 160)}`);
    argv.push('--file', abs);
  }
  const imgs = Array.isArray(images) ? images : [];
  if (imgs.length > 8) fail('CLI relay takes at most 8 images.');
  let imageDir = null;
  if (imgs.length) {
    imageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'barang-relay-'));
    let i = 0;
    for (const im of imgs) {
      const dataUrl = String(im?.dataUrl ?? '');
      const name = String(im?.filename ?? `image-${++i}.png`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || `image-${i}.png`;
      if (!DATAURL_RE.test(dataUrl)) fail(`Relay image unreadable: ${name.slice(0, 80)}`);
      if (dataUrl.length > 12_000_000) fail(`Relay image too large: ${name.slice(0, 80)}`);
      const fp = path.join(imageDir, `${i}-${name}`);
      await fs.writeFile(fp, Buffer.from(dataUrl.split(',')[1], 'base64'));
      argv.push('--file', fp);
      staged.push(fp);
      i++;
    }
  }
  if (auto) argv.push('--auto');
  const total = argv.reduce((n, a) => n + String(a).length, 0);
  if (total > 24000) fail('Message too long for CLI relay (>24KB of args) — shorten it or use another model.');
  return { argv, imageDir, staged };
}

/**
 * Start one relayed run. `hooks.broadcast(event)` forwards
 * { runId, kind, ... } to renderer windows (kinds: event/alive/exit).
 * Only one run at a time (renderer also gates; this is the backstop).
 */
export async function startRelay(args, { root, broadcast } = {}) {
  if (!root) fail('No folder open');
  for (const [id, r] of runs) {
    if (!r.done) fail(`A CLI relay run is already active (${id})`);
  }
  const { promises: fs } = await import('node:fs');
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) fail('Project folder is gone');
  } catch {
    fail('Project folder is gone');
  }
  const found = await findOpencode();
  const { argv, imageDir } = await buildArgv(args);
  const direct = isDirectBinary(found.command);
  const runId = `relay_${Date.now().toString(36)}_${(++seq).toString(36)}`;
  const child = spawn(found.command, argv, {
    cwd: root,
    shell: direct ? false : isWin, // shims need a shell; a real binary must NOT get one
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rec = { child, sessionID: null, imageDir, done: false, startedAt: Date.now() };
  runs.set(runId, rec);
  const send = (ev) => {
    try {
      broadcast('relay:event', { runId, ...ev });
    } catch {
      /* renderer gone */
    }
  };
  let outBuf = '';
  let errTail = '';
  let eventCount = 0;
  const cleanupStaged = async () => {
    if (!imageDir) return;
    try {
      const { promises: f2 } = await import('node:fs');
      await f2.rm(imageDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  child.stdout?.on('data', (d) => {
    outBuf += String(d);
    // Hard memory bound: keep only the tail; parse what fits.
    if (outBuf.length > 1_048_576) outBuf = outBuf.slice(outBuf.length - 1_048_576);
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0 && eventCount < MAX_EVENT_LINES) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      eventCount++;
      let parsed = null;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && typeof o.type === 'string') {
          parsed = { type: o.type };
          if (typeof o.sessionID === 'string' && SESSION_ID_RE.test(o.sessionID)) {
            parsed.sessionID = o.sessionID;
            if (!rec.sessionID) rec.sessionID = o.sessionID;
          }
          const part = o.part && typeof o.part === 'object' ? o.part : null;
          if (part) {
            if (typeof part.text === 'string') parsed.text = part.text.slice(0, 4000);
            if (typeof part.tool === 'string') parsed.tool = String(part.tool).slice(0, 80);
            const stt = part.state && typeof part.state === 'object' ? part.state : null;
            if (stt && typeof stt.status === 'string') parsed.toolStatus = String(stt.status).slice(0, 32);
            const ttl = (stt && typeof stt.title === 'string' && stt.title) || (typeof part.title === 'string' && part.title);
            if (ttl) parsed.toolTitle = String(ttl).slice(0, 120);
            if (typeof part.reason === 'string') parsed.finishReason = String(part.reason).slice(0, 32);
          }
        }
      } catch {
        /* non-JSON banner/warning line — heartbeat only */
      }
      send(parsed ? { kind: 'event', event: parsed } : { kind: 'heartbeat' });
    }
  });
  child.stderr?.on('data', (d) => {
    errTail = (errTail + String(d)).slice(-MAX_STDERR_TAIL);
  });
  const finish = (code, signal, timedOut) => {
    if (rec.done) return;
    rec.done = true;
    try {
      clearInterval(rec.aliveTimer);
    } catch {
      /* noop */
    }
    runs.delete(runId);
    void cleanupStaged();
    send({ kind: 'exit', code, signal: signal || null, timedOut: !!timedOut, sessionID: rec.sessionID, stderrTail: errTail });
  };
  child.on('error', (e) => {
    errTail = (errTail + `\nspawn error: ${e.message}`).slice(-MAX_STDERR_TAIL);
    finish(null, null, false);
  });
  child.on('exit', (code, signal) => finish(code, signal, false));
  // Liveness heartbeat: a relayed run can go quiet for minutes (long tool
  // calls) while perfectly healthy. The renderer's stall detector must not
  // demand a resend for that — aliveness resets its clock. There is
  // deliberately no time cap: the run ends on process exit or user stop.
  try {
    rec.aliveTimer = setInterval(() => {
      if (!rec.done) send({ kind: 'alive', pid: child.pid || null });
    }, 15000);
    rec.aliveTimer.unref?.();
  } catch {
    /* heartbeats are best-effort */
  }
  return { runId };
}

/** Abort a relay run (Stop button). Returns true when something was stopped. */
export function abortRelay(runId) {
  const rec = runs.get(String(runId));
  if (!rec || rec.done) return false;
  tryStop(rec.child);
  return true;
}

/** Kill all relay runs (app quit). */
export function shutdownRelays() {
  for (const [, rec] of runs) {
    try {
      if (!rec.done) tryStop(rec.child);
    } catch {
      /* noop */
    }
  }
  runs.clear();
}
