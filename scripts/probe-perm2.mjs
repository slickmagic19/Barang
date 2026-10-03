// Dev-only probe part 2: permission.updated shape + respond enum + clean-run
// message shapes, using a WORKING model. Run: node scripts/probe-perm2.mjs
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe2-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe2] ${k}:`, typeof v === 'string' ? v.slice(0, 500) : v); };

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');
const H = { Authorization: auth, 'content-type': 'application/json' };
const work = join(tmpdir(), 'barang-probe'); // bash:ask already patched here

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.text() };
  };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: await r.text() };
  };

  const prov = await get('/config/providers');
  const pj = JSON.parse(prov.body);
  note('providers-keys', Object.keys(pj).join(','));
  const list = pj.providers ?? pj.all ?? pj.data ?? [];
  note('provider-ids', (Array.isArray(list) ? list : []).map((p) => p.id ?? p).join(',').slice(0, 400));
  const cfg = await get('/config');
  try {
    const cj = JSON.parse(cfg.body);
    note('config-model', JSON.stringify({ model: cj.model, small_model: cj.small_model }).slice(0, 200));
  } catch { note('config-model', cfg.body.slice(0, 200)); }

  // pick model: opencode/* free first, else omit (server default)
  let model;
  for (const p of (Array.isArray(list) ? list : [])) {
    const ids = Array.isArray(p.models) ? p.models.map((m) => (typeof m === 'string' ? m : m.id)) : Object.keys(p.models ?? {});
    const f = ids.find((id) => /muse-spark/i.test(id)) ?? ids.find((id) => /free/i.test(id));
    if (f && (p.id === 'opencode' || !model)) { model = { providerID: p.id, modelID: f }; if (p.id === 'opencode') break; }
  }
  note('probe-model', model ? `${model.providerID}/${model.modelID}` : 'SERVER-DEFAULT');

  const cs = await post('/session', { title: 'barang perm probe 2' });
  const sid = JSON.parse(cs.body).id;
  const pa = await post(`/session/${sid}/prompt_async`, {
    ...(model ? { model } : {}),
    agent: 'build',
    parts: [{ type: 'text', text: 'Run the shell command `echo perm-probe-hello` using bash, then reply with exactly what it printed. Do nothing else.' }],
  });
  note('prompt_async', `${pa.status} body=${pa.body.slice(0, 100)}`);

  const frames = [];
  let perm = null;
  let replied = null;
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
          if (t.includes('permission')) {
            frames.push(`${t} :: ${JSON.stringify(inner?.properties ?? inner).slice(0, 900)}`);
            if ((t === 'permission.updated' || t === 'permission.asked') && !perm) perm = inner?.properties ?? inner;
            if (t === 'permission.replied' && !replied) replied = inner?.properties ?? inner;
          }
          if (t === 'session.error') frames.push(`session.error :: ${JSON.stringify(inner?.properties ?? inner).slice(0, 900)}`);
        } catch { /* non-JSON */ }
      }
    }
    if (perm) break;
    try {
      const st = await get('/session/status');
      const cur = JSON.parse(st.body)?.[sid];
      if (cur && cur.type === 'idle') { note('run-went-idle-no-perm', JSON.stringify(cur).slice(0, 200)); break; }
      if (cur && cur.type === 'retry') note('run-retrying', `${cur.attempt} ${(cur.message ?? '').slice(0, 160)}`);
    } catch { /* ignore */ }
    // what is the run actually doing? dump tool-part states
    try {
      const ms = await get(`/session/${sid}/message?limit=4`);
      const arr = JSON.parse(ms.body);
      const last = arr[arr.length - 1];
      const tools = (last?.parts ?? []).filter((p) => p?.type === 'tool').map((p) => `${p.tool}:${p?.state?.status}`);
      if (tools.length) note('tool-states', `${last?.info?.role} [${tools.join(', ')}]`);
    } catch { /* ignore */ }
  }
  try { await reader.cancel(); } catch { /* noop */ }
  note('permission-frames', frames.length ? frames.join('\n') : 'NONE');

  if (perm?.id) {
    for (const resp of ['allow', 'once', 'always', 'reject', 'deny']) {
      const r = await post(`/session/${sid}/permissions/${perm.id}`, { response: resp });
      note(`respond-${resp}`, `${r.status} ${r.body.slice(0, 160)}`);
      if (r.status === 200 && r.body.includes('true')) break;
    }
    await new Promise((r) => setTimeout(r, 20000));
    const msgs = await get(`/session/${sid}/message?limit=6`);
    try {
      const arr = JSON.parse(msgs.body);
      note('message-tail', JSON.stringify(arr.slice(-3).map((m) => ({ role: m?.info?.role, err: m?.info?.error ?? null, parts: (m?.parts ?? []).map((p) => p?.type) })), null, 1).slice(0, 2000));
    } catch (e) { note('message-tail', `parse-fail ${msgs.status}`); }
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe2] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
