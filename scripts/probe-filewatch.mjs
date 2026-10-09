// Dev-only probe: which /event frames fire on external file writes?
// Run: node scripts/probe-filewatch.mjs (~40s)
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServer } from '../electron/main/opencode.js';

process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'probe123';
process.resourcesPath = 'C:\\nonexistent-barang-probe';
const auth = 'Basic ' + Buffer.from('opencode:probe123').toString('base64');
const work = join(tmpdir(), 'barang-probe');

let server = null;
try {
  server = await startOpencodeServer({ cwd: work, onLog: () => {} });
  const base = server.base;
  const seen = [];
  const stream = await fetch(base + '/event', { headers: { Authorization: auth }, signal: AbortSignal.timeout(35000) });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const target = join(work, 'watch-probe.txt');
  try { await rm(target, { force: true }); } catch {}
  await new Promise((r) => setTimeout(r, 2000)); // let watcher settle
  await writeFile(target, 'hello');
  await new Promise((r) => setTimeout(r, 1500));
  await writeFile(target, 'hello again');
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: null }), 3000)),
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
          if (t.includes('file') || t.includes('watcher') || t.includes('vcs')) {
            seen.push(`${t} :: ${JSON.stringify(inner?.properties ?? inner).slice(0, 220)}`);
          }
        } catch { /* non-JSON */ }
      }
    }
  }
  try { await reader.cancel(); } catch { /* noop */ }
  console.log('[probefw] file-frames:');
  console.log(seen.length ? seen.join('\n') : 'NONE');
  try { await rm(target, { force: true }); } catch {}
} finally {
  try { server?.stop(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref?.();
}
