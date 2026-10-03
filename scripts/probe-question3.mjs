// Dev-only probe part 5: abort unblocks question waits? + session question list.
// Run: node scripts/probe-question3.mjs  (self-stops its server, ~3 min max)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe5-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe5] ${k}:`, typeof v === 'string' ? v.slice(0, 500) : v); };

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
  const cs = await post('/session', { title: 'barang abort probe' });
  const sid = JSON.parse(cs.body).id;
  await post(`/session/${sid}/prompt_async`, {
    model, agent: 'build',
    parts: [{ type: 'text', text: 'Use the question tool to ask me whether I prefer Red or Blue, with those two options. Then WAIT for my answer. Do nothing else until I answer.' }],
  });

  let qid = null;
  const deadline = Date.now() + 100000;
  const stream = await fetch(base + '/event', { headers: { Authorization: auth }, signal: AbortSignal.timeout(105000) });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (Date.now() < deadline && !qid) {
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
          if (inner?.type === 'question.asked') qid = inner?.properties?.id;
          if (inner?.type === 'question.rejected' || inner?.type === 'question.replied') note('q-event', inner?.type);
        } catch { /* non-JSON */ }
      }
    }
  }
  try { await reader.cancel(); } catch { /* noop */ }
  note('question-asked', qid ?? 'NONE');

  if (qid) {
    // v2 session-scoped list: does it see the legacy question?
    const sq = await get(`/api/session/${sid}/question`);
    note('session-question-list', `${sq.status} ${sq.body.slice(0, 300)}`);
    // Abort while waiting on the question.
    const ab = await post(`/session/${sid}/abort`, {}, 15000);
    note('abort-post', `${ab.status} in ${ab.ms}ms body=${ab.body.slice(0, 100)}`);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      let cur = null;
      try {
        const s = await get('/session/status');
        cur = JSON.parse(s.body)?.[sid] ?? null;
      } catch { /* ignore */ }
      note(`status-t${(i + 1) * 2}s`, JSON.stringify(cur));
      if (cur && cur.type === 'idle') break;
    }
    const ql = await get('/question');
    note('legacy-list-after', `${ql.status} ${ql.body.slice(0, 200)}`);
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe5] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
