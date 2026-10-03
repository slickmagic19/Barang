// Dev-only probe part 6: model variants + prompt schema strictness on 1.18.33.
// Run: node scripts/probe-variant.mjs  (~60s, no model calls except none)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe6-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probe6] ${k}:`, typeof v === 'string' ? v.slice(0, 1200) : v); };

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

  // 1) full model objects: variants? options? limit?
  const prov = await get('/config/providers');
  const pj = JSON.parse(prov.body);
  const list = pj.providers ?? pj.all ?? [];
  const oc = list.find((p) => p.id === 'opencode');
  note('opencode-provider-keys', oc ? Object.keys(oc).join(',') : 'NONE');
  if (oc) {
    const models = oc.models;
    const ids = Array.isArray(models) ? models.map((m) => (typeof m === 'string' ? m : m.id)) : Object.keys(models ?? {});
    note('opencode-model-ids', ids.slice(0, 12).join(','));
    const sparkKey = ids.find((id) => /muse-spark/i.test(id));
    const sparkObj = Array.isArray(models) ? models.find((m) => typeof m !== 'string' && m.id === sparkKey) : models?.[sparkKey];
    note('spark-model-object', JSON.stringify(sparkObj).slice(0, 2000));
  }
  // any model anywhere with variants?
  let withVariants = [];
  for (const p of list) {
    const models = p.models;
    const arr = Array.isArray(models) ? models.filter((m) => typeof m !== 'string') : Object.entries(models ?? {}).map(([id, m]) => ({ id, ...(typeof m === 'object' ? m : {}) }));
    for (const m of arr) {
      const v = m.variants ?? m.options?.variants ?? m.variant;
      if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) withVariants.push(`${p.id}/${m.id}: ${JSON.stringify(v).slice(0, 200)}`);
      if (withVariants.length >= 6) break;
    }
    if (withVariants.length >= 6) break;
  }
  note('models-with-variants', withVariants.length ? withVariants.join('\n') : 'NONE-FOUND');

  // 2) schema strictness: bogus field on a FAKE session (no model run).
  const bad = await post('/session/ses_fake123/message', { bogusField_xyz: 1, parts: [{ type: 'text', text: 'hi' }] });
  note('bogus-field-fake-session', `${bad.status} ${bad.body.slice(0, 300)}`);
  const bad2 = await post('/session/ses_fake123/prompt_async', { bogusField_xyz: 1, parts: [{ type: 'text', text: 'hi' }] });
  note('bogus-field-prompt-async', `${bad2.status} ${bad2.body.slice(0, 300)}`);
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probe6] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
