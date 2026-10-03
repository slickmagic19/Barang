// Dev-only probe: GET /command shape on 1.18.33. Run: node scripts/probe-command.mjs
import { startOpencodeServer } from '../electron/main/opencode.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');

let server = null;
try {
  server = await startOpencodeServer({ cwd: join(tmpdir(), 'barang-probe'), onLog: () => {} });
  const r = await fetch(server.base + '/command', { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
  console.log('status=' + r.status);
  console.log((await r.text()).slice(0, 1500));
} finally {
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
