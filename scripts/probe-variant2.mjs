// Dev-only probe part 7: how does 1.18.33 consume model variants?
// Run: node scripts/probe-variant2.mjs (~2 min, two tiny free-model calls)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe7-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe7] ${k}:`, typeof v === 'string' ? v.slice(0, 800) : v); };

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
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };
  const model = { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' };

  for (const [name, extra] of [
    ['model.variant', { model: { ...model, variant: 'low' } }],
    ['toplevel.variant', { model, variant: 'low' }],
  ]) {
    const cs = await post('/session', { title: `variant probe ${name}` });
    const sid = JSON.parse(cs.body).id;
    const pa = await post(`/session/${sid}/prompt_async`, {
      ...extra,
      agent: 'build',
      parts: [{ type: 'text', text: 'Reply with exactly the two letters OK and nothing else. No tools.' }],
    });
    note(`${name} submit`, `${pa.status} ${pa.body.slice(0, 160)}`);
    if (pa.status !== 204 && pa.status !== 200) continue;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let cur = null;
      try { cur = JSON.parse((await get('/session/status')).body)?.[sid]; } catch { /* ignore */ }
      if (cur && cur.type === 'idle') break;
      if (i === 19) note(`${name} settled`, `no: ${JSON.stringify(cur)}`);
    }
    const msgs = await get(`/session/${sid}/message?limit=4`);
    try {
      const arr = JSON.parse(msgs.body);
      note(`${name} messages`, JSON.stringify(arr.map((m) => ({
        role: m?.info?.role,
        model: m?.info?.model ?? (m?.info?.modelID ? { providerID: m.info.providerID, modelID: m.info.modelID } : undefined),
        text: ((m?.parts ?? []).find((p) => p?.type === 'text')?.text ?? '').slice(0, 60),
      })), null, 1).slice(0, 1500));
    } catch { note(`${name} messages`, 'parse-fail'); }
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe7] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
