// Dev-only probe part 6: /session/status map semantics (missing key = ?).
// Run: node scripts/probe-status.mjs  (~90s)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe6-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe6] ${k}:`, typeof v === 'string' ? v.slice(0, 400) : v); };

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
  const cs = await post('/session', { title: 'status semantics' });
  const sid = JSON.parse(cs.body).id;
  const raw = async () => (await get('/session/status')).body;
  note('fresh', await raw());
  await post(`/session/${sid}/prompt_async`, {
    model, agent: 'build',
    parts: [{ type: 'text', text: 'Reply with exactly the word HELLO and nothing else. No tools.' }],
  });
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    note(`t${(i + 1) * 3}s`, await raw());
    try {
      const cur = JSON.parse(await raw())?.[sid];
      if (cur && cur.type === 'idle') { note('idle-entry', 'server keeps idle entries'); break; }
    } catch { /* ignore */ }
    if (i === 11) note('idle-entry', 'never saw an idle entry');
  }
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe6] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
