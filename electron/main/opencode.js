// opencode CLI lifecycle for the Electron main process.
// Same battle-tested logic as the original bridge: the app NEVER handles model
// auth (the user's `opencode` CLI owns provider credentials); we just drive
// its `serve` server. On Windows the npm shim needs shell:true to spawn and
// taskkill /T to stop, or the server orphans and squats its port.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';

export const isWin = process.platform === 'win32';

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: isWin, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: '', stderr: String(stderr || err.message) });
      else resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Locate a runnable `opencode` command. Returns { command, version } or throws.
 *  The bundled binary is probed FIRST: on a new PC with no system opencode,
 *  the `opencode --version` shim probe would fail and wrongly report offline. */
export async function findOpencode() {
  const cmd = await resolveCommand();
  const direct = isDirectBinary(cmd);
  // Direct binaries run shell-free; shims need a shell (Windows npm shims).
  const probe = await runCapture(cmd, ['--version'], direct ? { shell: false } : {});
  if (!probe.ok) {
    throw new Error(
      'Could not run the bundled or system opencode CLI. If you removed the bundled binary, ' +
        'install the opencode CLI (`npm install -g opencode-ai`, https://opencode.ai/docs) and restart Barang. ' +
        probe.stderr.trim(),
    );
  }
  const version = probe.stdout.trim().split(/\s+/).pop();
  return { command: cmd, version };
}

/**
 * Prefer the REAL opencode binary (spawned directly, no shell) over the npm
 * .cmd/.ps1 shims: direct children have clean pids, clean stdio, and clean
 * tree-kills. Falls back to the PATH shim (shell:true on Windows) when no
 * binary is found (curl/binary installs put `opencode` directly on PATH).
 *
 * Resolution order (first hit wins):
 *  1. Bundled with the installer: <resources>/vendor/opencode/<plat>-<arch>/
 *  2. Dev vendor dir (scripts/fetch-opencode.js): <app>/vendor/opencode/…/
 *  3. System install (npm -g / curl / package managers).
 */
async function resolveCommand() {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const exe = isWin ? 'opencode.exe' : 'opencode';
  const plat = isWin ? 'windows' : process.platform;
  const vendored = path.join('vendor', 'opencode', `${plat}-${process.arch}`, exe);
  const here = path.dirname(fileURLToPath(import.meta.url)); // electron/main
  const candidates = [
    // 1) packaged app resources
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, vendored) : '',
    // 2) dev checkout after `npm run fetch:opencode`
    path.resolve(here, '..', '..', vendored),
  ];
  // npm global root: <prefix>/node_modules/opencode-ai/bin/opencode(.exe)
  const npmRoot = await runCapture(isWin ? 'npm.cmd' : 'npm', ['root', '-g']);
  if (npmRoot.ok && npmRoot.stdout.trim()) {
    candidates.push(path.join(npmRoot.stdout.trim(), 'opencode-ai', 'bin', exe));
  }
  // Well-known npm prefix on Windows.
  if (isWin && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', exe));
  }
  // Whatever `where`/`which` finds: accept a real binary, and for shims look
  // for the package binary next to them.
  const located = await runCapture(isWin ? 'where' : 'which', ['opencode']);
  if (located.ok) {
    for (const line of located.stdout.split(/\r?\n/)) {
      const p = line.trim().replace(/^"|"$/g, '');
      if (!p) continue;
      if (/\.exe$/i.test(p)) candidates.push(p);
      const dir = path.dirname(p);
      candidates.push(path.join(dir, 'node_modules', 'opencode-ai', 'bin', exe));
      candidates.push(path.join(dir, '..', 'node_modules', 'opencode-ai', 'bin', exe));
    }
  }
  // Home-level installs (opencode docs mention ~/.opencode/bin).
  candidates.push(path.join(os.homedir(), '.opencode', 'bin', exe));
  for (const c of candidates) {
    try {
      const abs = path.resolve(c);
      await fs.access(abs);
      return abs;
    } catch {
      /* try next */
    }
  }
  return 'opencode'; // PATH shim fallback (needs shell on Windows)
}

/** True when `command` is a direct binary (no shell wrapper needed). */
export function isDirectBinary(command) {
  return command !== 'opencode' && !/\.(cmd|ps1|bat)$/i.test(command);
}

/** Auth header for the opencode server (Basic when password env is set, else none). */
export function serverAuthHeader() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const b64 = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${b64}` };
}

/** Ask the OS for a free loopback port. */
export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' ? addr.port : 0));
    });
  });
}

async function waitReady(port, timeoutMs = 60000) {
  const base = `http://127.0.0.1:${port}`;
  const headers = serverAuthHeader();
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      // Per-attempt timeout: a hung (accept-but-never-respond) server must
      // not stall the loop past the overall deadline — previously this
      // hung the app boot forever with no window and no error.
      const res = await fetch(`${base}/global/health`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return { base, version: body.version || 'unknown' };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? 'health timeout' : e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for \`opencode serve\` on port ${port} (${lastErr}).`);
}

/**
 * Start `opencode serve` rooted at `cwd` (0 = pick a free port).
 * Returns { base, port, version, cliVersion, child, stop }.
 */
export async function startOpencodeServer({ cwd, port = 0, onLog = () => {} }) {
  const found = await findOpencode();
  const listenPort = port || (await freePort());
  const direct = isDirectBinary(found.command);
  const bundled = found.command.toLowerCase().includes('vendor');
  const child = spawn(found.command, ['serve', '--port', String(listenPort), '--hostname', '127.0.0.1'], {
    cwd,
    shell: direct ? false : isWin, // shims need a shell; a real binary must NOT get one
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });
  onLog(`[barang] opencode: ${found.command} (pid ${child.pid}, direct=${direct}, bundled=${bundled})`);
  child.stdout?.on('data', (d) => onLog('[opencode] ' + d));
  child.stderr?.on('data', (d) => onLog('[opencode] ' + d));
  child.on('error', (e) => onLog('[opencode:error] ' + e.message));

  const ready = await waitReady(listenPort).catch((e) => {
    tryStop(child);
    throw e;
  });
  return {
    ...ready,
    port: listenPort,
    cliVersion: found.version,
    child,
    stop: () => tryStop(child),
  };
}

export function tryStop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) {
      // Kill the whole tree: with shell:true, child.pid is the wrapper shell.
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }, 3000).unref?.();
    }
  } catch {
    /* noop */
  }
}
