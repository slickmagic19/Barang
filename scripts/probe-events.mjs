// Logs the /event stream during a run to see which events fire and when,
// especially whether an "idle"/completion event is emitted after the message.
// Run: node scripts/probe-events.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO = path.join(ROOT, 'vendor', 'kilo', 'windows-x64', 'kilo.exe');
const PORT = 47841;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(BASE + p); return r.ok ? r.json() : null; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.status; };

const server = spawn(KILO, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], { windowsHide: true });
for (let i = 0; i < 40; i++) { await sleep(500); try { await get('/global/health'); break; } catch {} }

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

// Subscribe to /event (SSE).
const ac = new AbortController();
const evTypes = [];
const evp = (async () => {
  try {
    const res = await fetch(BASE + '/event', { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          const inner = ev.payload ?? ev;
          const type = inner.type || '?';
          if (!evTypes.includes(type)) { evTypes.push(type); console.log(el(), 'event:', type); }
        } catch {}
      }
    }
  } catch (e) { if (e.name !== 'AbortError') console.log('event stream err', e.message); }
})();

const created = await fetch(BASE + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'probe' }) }).then((r) => r.json());
const sid = created.id;
console.log(el(), 'session', sid);
console.log(el(), 'prompt sent', await post(`/session/${sid}/prompt_async`, { model: { providerID: 'kilo', modelID: 'kilo-auto/free' }, parts: [{ type: 'text', text: 'Reply with exactly: PONG' }] }));

// Poll status + message for ~15s.
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const sm = await get('/session/status').catch(() => ({}));
  const entry = sm?.[sid];
  const st = entry ? (entry.type || 'busy') : 'idle';
  const msgs = await get(`/session/${sid}/message`).catch(() => []);
  const asst = (Array.isArray(msgs) ? msgs : []).filter((m) => (m.info?.role || '').toLowerCase() === 'assistant');
  const done = asst.some((m) => (m.parts || []).some((p) => p.type === 'text' && (p.text || '').trim()));
  if (i % 2 === 0) console.log(el(), 'status=' + st, 'msgDone=' + done);
  if (st === 'idle' && done && i > 2) { console.log(el(), 'DONE: idle + message complete'); break; }
}

console.log('\nevent types seen:', evTypes.join(', '));
ac.abort();
server.kill();
process.exit(0);