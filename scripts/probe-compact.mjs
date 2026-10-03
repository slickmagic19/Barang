// Dev-only probe: /command list + compact route candidates on 1.18.33.
// Run: node scripts/probe-compact.mjs (~90s, no model runs expected)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe-compact-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probec] ${k}:`, typeof v === 'string' ? v.slice(0, 600) : v); };

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
  const post = async (p, body, ms = 25000) => {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };

  const cl = await get('/command');
  try {
    const arr = JSON.parse(cl.body);
    note('command-list', `${cl.status} names=[${arr.map((c) => c.name).join(',')}]`);
    note('command-sample', JSON.stringify(arr[0]).slice(0, 400));
  } catch { note('command-list', `${cl.status} parse-fail`); }

  const cs = await post('/session', { title: 'compact probe' });
  const sid = JSON.parse(cs.body).id;
  for (const p of [`/session/${sid}/compact`, `/session/${sid}/summarize`]) {
    const r = await post(p, {});
    note(`POST ${p.replace(sid, 'SID')}`, `${r.status} ${r.body.slice(0, 200)}`);
  }
  await get(`/session/${sid}`, 10000).catch(() => {});
  const del = await (async () => {
    const r = await fetch(base + `/session/${sid}`, { method: 'DELETE', headers: { Authorization: auth } });
    return r.status;
  })();
  note('cleanup-delete', String(del));
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probec] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
