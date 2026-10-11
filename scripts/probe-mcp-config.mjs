// Dev-only probe: OPENCODE_CONFIG custom file for MCP (no user files touched).
// Run: node scripts/probe-mcp-config.mjs (~60s)
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

const log = [];
const note = (k, v) => { log.push([k, v]); console.log(`[probemcp2] ${k}:`, typeof v === 'string' ? v.slice(0, 700) : v); };

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');
const H = { Authorization: auth, 'content-type': 'application/json' };
const work = join(tmpdir(), 'barang-probe-mcp');
await mkdir(work, { recursive: true });

// Our managed file: ONLY the mcp key (opencode merges the rest).
const managed = join(tmpdir(), 'barang-managed-mcp.json');
await writeFile(managed, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  mcp: {
    'wp-managed': {
      type: 'remote',
      url: 'https://example.invalid/wp-json/easy-mcp-ai/v1/mcp',
      oauth: false,
      headers: { Authorization: 'Bearer wpmcp_managed' },
    },
  },
}));
process.env.OPENCODE_CONFIG = managed;

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  const get = async (p, ms = 15000) => {
    const r = await fetch(base + p, { headers: { Authorization: auth }, signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  };
  const cfg = await get('/config');
  try {
    const cj = JSON.parse(cfg.body);
    note('config-mcp', JSON.stringify(cj.mcp ?? cj.data?.mcp ?? 'NO-MCP-KEY').slice(0, 500));
  } catch { note('config-mcp', `parse-fail ${cfg.status}`); }
  const m = await get('/mcp');
  note('mcp-status', `${m.status} ${m.body.slice(0, 400)}`);
} catch (e) {
  note('FATAL', String(e?.message ?? e));
} finally {
  delete process.env.OPENCODE_CONFIG;
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
