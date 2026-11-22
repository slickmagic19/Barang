// Measures the gap between "assistant message complete" and "/session/status idle"
// against the real kilo server. Helps confirm the busy-stuck root cause.
// Run: node scripts/probe-status-timing.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO = path.join(ROOT, 'vendor', 'kilo', 'windows-x64', 'kilo.exe');
const PORT = 47840;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  const r = await fetch(BASE + p);
  return r.ok ? r.json() : null;
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ok: r.ok };
};

const server = spawn(KILO, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], { windowsHide: true });
for (let i = 0; i < 40; i++) { await sleep(500); try { await get('/global/health'); break; } catch {} }

const providers = await get('/config/providers');
const kp = (providers.providers || []).find((p) => p.id === 'kilo');
const freeModel = 'kilo-auto/free';
console.log('using model:', freeModel, '(kilo free router)');

const created = await fetch(BASE + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'probe' }) }).then((r) => r.json());
const sid = created.id;
console.log('session:', sid);

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const sent = await post(`/session/${sid}/prompt_async`, {
  model: { providerID: 'kilo', modelID: freeModel },
  parts: [{ type: 'text', text: 'Reply with exactly the word: PONG' }],
});
console.log(el(), 'prompt sent, status', sent.status);

let msgCompleteAt = null;
let statusIdleAt = null;
let lastStatus = '';
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const statusMap = await get('/session/status').catch(() => ({}));
  const entry = statusMap?.[sid];
  const st = entry ? (entry.type || 'busy') : 'idle(no-entry)';
  if (st !== lastStatus) { console.log(el(), 'status:', st); lastStatus = st; }
  if (!entry && statusIdleAt === null && i > 0) statusIdleAt = Date.now();

  const msgs = await get(`/session/${sid}/message`).catch(() => []);
  const assistants = (Array.isArray(msgs) ? msgs : []).filter((m) => (m.info?.role || '').toLowerCase() === 'assistant');
  const last = assistants[assistants.length - 1];
  // A completed assistant message: has a text part and no run error, and the
  // session status entry is gone/idle (the run is done).
  const hasText = last && (last.parts || []).some((p) => p.type === 'text' && (p.text || '').trim());
  const hasErr = last?.info?.error;
  if (hasErr) console.log(el(), 'run error:', JSON.stringify(hasErr).slice(0, 160));
  if (hasText && !hasErr && msgCompleteAt === null) {
    msgCompleteAt = Date.now();
    console.log(el(), 'assistant message has text (complete-ish)');
  }
  if (statusIdleAt && msgCompleteAt) break;
  if (i === 119) console.log(el(), 'timeout waiting');
}

console.log('\n--- RESULT ---');
if (msgCompleteAt) console.log('message complete at', ((msgCompleteAt - t0) / 1000).toFixed(1) + 's');
if (statusIdleAt) console.log('status idle at     ', ((statusIdleAt - t0) / 1000).toFixed(1) + 's');
if (msgCompleteAt && statusIdleAt) console.log('gap (complete→idle):', ((statusIdleAt - msgCompleteAt) / 1000).toFixed(1) + 's');
else console.log('(did not observe both)');

server.kill();
process.exit(0);