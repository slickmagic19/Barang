// Dev-only probe: MCP config mechanics on 1.18.33 (PATCH persistence,
// GET /mcp shape, POST /mcp dynamic). Run: node scripts/probe-mcp.mjs
import { writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const OUT = join(tmpdir(), 'barang-probe-mcp-result.json');
const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probemcp] ${k}:`, typeof v === 'string' ? v.slice(0, 900) : v); };

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');
const H = { Authorization: auth, 'content-type': 'application/json' };
const work = join(tmpdir(), 'barang-probe-mcp');
const { mkdir } = await import('node:fs/promises');
await mkdir(work, { recursive: true });

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  const get = async (p, ms = 15000) => {
    const r = await fetch(base + p, { headers: { Authorization: auth }, signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };
  const patch = async (p, body, ms = 15000) => {
    const r = await fetch(base + p, { method: 'PATCH', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };
  const post = async (p, body, ms = 20000) => {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };

  const m0 = await get('/mcp');
  note('mcp-before', `${m0.status} ${m0.body.slice(0, 300)}`);

  // PATCH a remote MCP server in (WordPress-shaped, unreachable URL).
  const pr = await patch('/config', { mcp: { 'wp-probe': { type: 'remote', url: 'https://example.invalid/wp-json/easy-mcp-ai/v1/mcp', oauth: false, headers: { Authorization: 'Bearer wpmcp_probe' } } } });
  note('config-patch', `${pr.status} ${pr.body.slice(0, 500)}`);

  const m1 = await get('/mcp');
  note('mcp-after-patch', `${m1.status} ${m1.body.slice(0, 600)}`);

  // Did PATCH persist anywhere on disk?
  for (const f of [join(work, 'opencode.json'), join(work, '.opencode', 'opencode.json')]) {
    try {
      const t = await readFile(f, 'utf8');
      note('disk-config ' + f.replace(work, '<root>'), t.slice(0, 400));
    } catch { note('disk-config ' + f.replace(work, '<root>'), 'ABSENT'); }
  }

  // POST /mcp dynamic add.
  const pd = await post('/mcp', { name: 'wp-dynamic', config: { type: 'remote', url: 'https://example.invalid/mcp', oauth: false } });
  note('post-mcp', `${pd.status} ${pd.body.slice(0, 400)}`);
  const m2 = await get('/mcp');
  note('mcp-after-post', `${m2.status} ${m2.body.slice(0, 600)}`);
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  await writeFile(OUT, JSON.stringify(log, null, 1));
  console.log(`[probemcp] results -> ${OUT}`);
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
