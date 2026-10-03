// Dev-only probe part 3: question-tool waits + abort effectiveness.
// Run: node scripts/probe-question.mjs  (self-stops its server, ~3 min max)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe3-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe3] ${k}:`, typeof v === 'string' ? v.slice(0, 600) : v); };

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');
const H = { Authorization: auth, 'content-type': 'application/json' };
const work = join(tmpdir(), 'barang-probe');

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  const get = async (p, ms = 15000) => {
    const r = await fetch(base + p, { headers: { Authorization: auth }, signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };
  const post = async (p, body, ms = 20000) => {
    const t0 = Date.now();
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });
    return { status: r.status, ms: Date.now() - t0, body: await r.text() };
  };

  const model = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };
  const cs = await post('/session', { title: 'barang question probe' });
  const sid = JSON.parse(cs.body).id;
  note('session', sid);

  // Ask the model to wait on the question tool (no other tools).
  const pa = await post(`/session/${sid}/prompt_async`, {
    model, agent: 'build',
    parts: [{ type: 'text', text: 'Use the question tool to ask me whether I prefer option Alpha or option Beta for a logo background, with those two options plus a third custom one. Then WAIT for my answer. Do not do anything else until I answer.' }],
  });
  note('prompt_async', `${pa.status}`);

  // Watch events + tool states; auto-allow any permission ask (log it).
  const seen = [];
  let questionState = null;
  const deadline = Date.now() + 100000;
  const stream = await fetch(base + '/event', { headers: { Authorization: auth }, signal: AbortSignal.timeout(105000) });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: null }), 4000)),
    ]);
    if (done) break;
    if (value) {
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
        if (!lines.length) continue;
        try {
          const ev = JSON.parse(lines.join('\n'));
          const inner = ev?.payload ?? ev;
          const t = inner?.type ?? '?';
          if (t.includes('permission') || t.includes('question') || t === 'session.error') {
            seen.push(`${t} :: ${JSON.stringify(inner?.properties ?? inner).slice(0, 700)}`);
          }
          if ((t === 'permission.asked' || t === 'permission.updated') && !(inner?.properties ?? inner)?.responded) {
            const pr = inner?.properties ?? inner;
            if (pr?.id && seen.filter((s) => s.startsWith('auto-respond')).length < 3) {
              const rr = await post(`/session/${sid}/permissions/${pr.id}`, { response: 'once' });
              seen.push(`auto-respond once -> ${rr.status} ${rr.body.slice(0, 80)}`);
            }
          }
        } catch { /* non-JSON */ }
      }
    }
    try {
      const ms = await get(`/session/${sid}/message?limit=4`);
      const arr = JSON.parse(ms.body);
      const last = arr[arr.length - 1];
      const tools = (last?.parts ?? []).filter((p) => p?.type === 'tool').map((p) => {
        const st = p?.state;
        return `${p.tool}:${st?.status}:${JSON.stringify(st?.input ?? {}).slice(0, 120)}`;
      });
      if (tools.length && JSON.stringify(tools) !== questionState) {
        questionState = JSON.stringify(tools);
        note('tool-states', `${last?.info?.role} [${tools.join(' | ')}]`);
      }
      const st = await get('/session/status');
      const cur = JSON.parse(st.body)?.[sid];
      if (cur && cur.type === 'idle') { note('run-idle', 'run finished on its own'); break; }
    } catch { /* ignore */ }
  }
  try { await reader.cancel(); } catch { /* noop */ }
  note('interesting-frames', seen.length ? seen.join('\n') : 'NONE');

  // Now the abort test: is the run still busy? Does /abort take effect?
  const stBefore = await get('/session/status');
  note('status-before-abort', JSON.stringify(JSON.parse(stBefore.body)?.[sid]).slice(0, 300));
  const ab = await post(`/session/${sid}/abort`, {}, 15000);
  note('abort-post', `${ab.status} in ${ab.ms}ms body=${ab.body.slice(0, 100)}`);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await get('/session/status');
    const cur = JSON.parse(s.body)?.[sid];
    note(`status-after-abort-t${(i + 1) * 2}s`, JSON.stringify(cur).slice(0, 200));
    if (cur && cur.type === 'idle') break;
  }
  const msgs = await get(`/session/${sid}/message?limit=6`);
  try {
    const arr = JSON.parse(msgs.body);
    note('message-tail', JSON.stringify(arr.slice(-2).map((m) => ({ role: m?.info?.role, err: m?.info?.error ?? null, parts: (m?.parts ?? []).map((p) => p?.type) })), null, 1).slice(0, 1500));
  } catch { note('message-tail', 'parse-fail'); }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe3] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
