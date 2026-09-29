// Zero-dependency dev runner: starts Vite for the renderer, then the
// Electron desktop app pointed at it. Usage: node scripts/dev-electron.js
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const WEB_PORT = process.env.BARANG_WEB_PORT || '5173';
const viteUrl = `http://127.0.0.1:${WEB_PORT}`;
const children = [];

function run(cmd, args, env, tag) {
  const child = spawn(cmd, args, { shell: isWin, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on('exit', (code) => console.log(`[${tag}] exited with code ${code}`));
  return child;
}

run('npm', ['--prefix', 'web', 'run', 'dev', '--', '--port', WEB_PORT, '--strictPort'],
  process.env, 'web');

setTimeout(() => {
  run('npx', ['electron', '.'], { ...process.env, BARANG_VITE: viteUrl }, 'app');
}, 2500);

function shutdown() {
  console.log('\nShutting down…');
  for (const c of children) {
    try {
      if (isWin) spawn('taskkill', ['/F', '/T', '/PID', String(c.pid)], { shell: true });
      else c.kill('SIGTERM');
    } catch { /* noop */ }
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
