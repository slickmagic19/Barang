// Dev-only probe: drives the vendored opencode `serve` directly to capture
// REAL 1.18.x API shapes (permission events, respond enum, prompt_async).
// Run: node scripts/probe-perm.mjs   (self-stops its server, ~2 min max)
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe] ${k}:`, typeof v === 'string' ? v.slice(0, 300) : v); };

const PASSWORD = 'probe123';
process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = PASSWORD;
// Plain node has no process.resourcesPath, which makes the '' candidate
// resolve to cwd (a directory, access() passes, spawn explodes). Point it
// somewhere dead so resolution falls through to the dev vendor binary.
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from(`opencode:${PASSWORD}`).toString('base64');
const H = { Authorization: auth, 'content-type': 'application/json' };

const work = join(tmpdir(), 'barang-probe');
await mkdir(work, { recursive: true });

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  note('base', base);
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.text() };
  };
  const post = async (p, body) => {
    const t0 = Date.now();
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20000) });
    return { status: r.status, ms: Date.now() - t0, body: await r.text() };
  };

  // 1) providers: find a free model to force (deterministic, no paid surprise)
  const prov = await get('/config/providers');
  const pj = JSON.parse(prov.body);
  const all = pj.providers ?? pj.all ?? [];
  const found = [];
  for (const p of all) {
    const models = Array.isArray(p.models) ? p.models : Object.keys(p.models ?? {});
    for (const m of models) {
      const id = typeof m === 'string' ? m : m.id;
      if (/free|muse-spark/i.test(`${p.id}/${id}`)) found.push(`${p.id}/${id}`);
    }
  }
  note('free-models', found.slice(0, 8).join(', ') || 'NONE');
  if (!found.length) throw new Error('no free model available for probe');
  const [providerID, ...rest] = found.find((f) => f.startsWith('opencode/'))?.split('/') ?? found[0].split('/');
  const modelID = rest.join('/');

  // 2) force a permission prompt: bash -> ask (record prior value)
  const cfg0 = await get('/config');
  note('config-permission-before', (cfg0.body.match(/"permission"[^}]{0,200}/) ?? ['?'])[0]);
  const patch = await (async () => {
    const r = await fetch(base + '/config', { method: 'PATCH', headers: H, body: JSON.stringify({ permission: { bash: 'ask' } }), signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  })();
  note('config-patch', `${patch.status} ${patch.body}`);

  // 3) session + async prompt (time it: must NOT block on the run)
  const cs = await post('/session', { title: 'barang perm probe' });
  const sid = JSON.parse(cs.body).id;
  note('session', sid);
  const pa = await post(`/session/${sid}/prompt_async`, {
    model: { providerID, modelID },
    agent: 'build',
    parts: [{ type: 'text', text: 'Run the shell command `echo perm-probe-hello` using bash, then reply with exactly what it printed. Do nothing else.' }],
  });
  note('prompt_async', `${pa.status} in ${pa.ms}ms body=${pa.body.slice(0, 120)}`);

  // 4) watch the event stream for permission frames (60s budget)
  const frames = [];
  const deadline = Date.now() + 60000;
  const stream = await fetch(base + '/event', { headers: { Authorization: auth }, signal: AbortSignal.timeout(65000) });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let permFrame = null;
  let statusSeen = [];
  while (Date.now() < deadline && !permFrame) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: null, timeout: true }), 5000)),
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
          const t = ev?.payload?.type ?? ev?.type ?? '?';
          if (t.includes('permission')) {
            frames.push(frame.slice(0, 2000));
            if (t === 'permission.updated' && !permFrame) permFrame = ev?.payload?.properties ?? ev?.properties ?? ev;
          }
          if (t.includes('session.status') || t.includes('session.status')) statusSeen.push(JSON.stringify(ev?.payload?.properties ?? ev?.properties).slice(0, 160));
        } catch { /* non-JSON */ }
      }
    }
    // also poll status so we can see busy/retry transitions
    if (statusSeen.length < 6) {
      try {
        const st = await get('/session/status');
        const j = JSON.parse(st.body);
        const cur = JSON.stringify(j?.[sid] ?? null);
        if (!statusSeen.includes(cur)) statusSeen.push(cur);
      } catch { /* ignore */ }
    }
  }
  try { await reader.cancel(); } catch { /* noop */ }
  note('permission-frame', permFrame ? JSON.stringify(permFrame).slice(0, 1200) : 'NONE-SEEN');
  note('status-transitions', statusSeen.slice(0, 8).join(' | ') || 'none');

  // 5) try respond enum values in order, record what the server accepts
  if (permFrame?.id) {
    for (const resp of ['allow', 'once', 'always', 'reject', 'deny']) {
      const r = await post(`/session/${sid}/permissions/${permFrame.id}`, { response: resp });
      note(`respond-${resp}`, `${r.status} ${r.body.slice(0, 160)}`);
      if (r.status === 200 && r.body.includes('true')) break;
    }
    // wait a bit, then dump the tail of the messages for error shapes
    await new Promise((r) => setTimeout(r, 15000));
    const msgs = await get(`/session/${sid}/message?limit=10`);
    try {
      const arr = JSON.parse(msgs.body);
      const tail = arr.slice(-2).map((m) => ({ role: m?.info?.role, err: m?.info?.error ?? null, parts: (m?.parts ?? []).map((p) => p?.type) }));
      note('message-tail', JSON.stringify(tail).slice(0, 1500));
    } catch (e) { note('message-tail', `parse-fail ${msgs.status}`); }
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
