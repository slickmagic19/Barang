// Dev-only probe part 4: question reply/reject routes on 1.18.33.
// Run: node scripts/probe-question2.mjs  (self-stops its server, ~3 min max)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe4-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe4] ${k}:`, typeof v === 'string' ? v.slice(0, 500) : v); };

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

  // Route discovery first (no pending question needed for list).
  for (const p of ['/question', '/api/question/request']) {
    const r = await get(p);
    note(`GET ${p}`, `${r.status} ${r.body.slice(0, 160)}`);
  }

  const model = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };
  const cs = await post('/session', { title: 'barang question probe 2' });
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
          if (inner?.type === 'question.asked') {
            qid = inner?.properties?.id;
            note('question', JSON.stringify(inner?.properties).slice(0, 600));
          }
        } catch { /* non-JSON */ }
      }
    }
  }
  try { await reader.cancel(); } catch { /* noop */ }

  if (qid) {
    const ql = await get('/question');
    note('GET /question (pending)', `${ql.status} ${ql.body.slice(0, 400)}`);
    // Candidate reply routes: v2 /api shape first (protocol source), then legacy.
    const tries = [
      `/api/session/${sid}/question/${qid}/reply`,
      `/session/${sid}/question/${qid}/reply`,
      `/question/${qid}/reply`,
    ];
    for (const p of tries) {
      const r = await post(p, { answers: [['Red']] });
      note(`POST ${p.replace(sid, 'SID').replace(qid, 'QID')}`, `${r.status} ${r.body.slice(0, 200)}`);
      if (r.status === 200 || r.status === 204) break;
    }
    // Did the run resume and finish?
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await get('/session/status');
      let cur = null;
      try { cur = JSON.parse(s.body)?.[sid]; } catch { /* ignore */ }
      if (cur && cur.type === 'idle') { note('run-idle-after-reply', 'yes'); break; }
      if (i === 9) note('run-idle-after-reply', `no: ${JSON.stringify(cur).slice(0, 160)}`);
    }
    const msgs = await get(`/session/${sid}/message?limit=3`);
    try {
      const arr = JSON.parse(msgs.body);
      note('tail', JSON.stringify(arr.slice(-1).map((m) => ({ role: m?.info?.role, parts: (m?.parts ?? []).map((p) => p?.type + (p?.tool ? ':' + p.tool + ':' + (p?.state?.status ?? '?') : '')) })), null, 1).slice(0, 900));
    } catch { note('tail', 'parse-fail'); }
  } else {
    note('question', 'NONE ASKED');
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe4] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
