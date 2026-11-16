// KiloCode CLI lifecycle for the desktop shell.
// Barang NEVER handles model auth (the user's `kilo` CLI owns provider
// credentials); we drive its `serve` server. Kilo Code is an OpenCode fork,
// so the HTTP surface (/global/health, /agent, /session, /event, /config/*)
// is identical — only the binary name and env prefix change.
// On Windows the npm shim needs shell:true to spawn and taskkill /T to stop,
// or the server orphans and squats its port.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';

export const isWin = process.platform === 'win32';

const EXE = isWin ? 'kilo.exe' : 'kilo';
const PLATFORM = isWin ? 'windows' : process.platform;
const PKG = `@kilocode/cli-${PLATFORM}-${process.arch}`;

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: isWin, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: '', stderr: String(stderr || err.message) });
      else resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Locate a runnable `kilo` command. Returns { command, version } or throws.
 *  The bundled binary is probed FIRST: on a new PC with no system kilo, a
 *  PATH-shim probe would fail and wrongly report offline. */
export async function findKilo() {
  const cmd = await resolveCommand();
  const direct = isDirectBinary(cmd);
  // Direct binaries run shell-free; shims need a shell (Windows npm shims).
  const probe = await runCapture(cmd, ['--version'], direct ? { shell: false } : {});
  if (!probe.ok) {
    throw new Error(
      'Could not run the bundled or system Kilo Code CLI. If you removed the bundled binary, ' +
        'install it (`npm install -g @kilocode/cli`, https://kilo.ai/docs) and restart Barang. ' +
        probe.stderr.trim(),
    );
  }
  // `kilo --version` prints a single version token (e.g. 7.8.27). Tolerate
  // banner/log lines by taking the last whitespace-separated token.
  const version = probe.stdout.trim().split(/\s+/).pop() || 'unknown';
  return { command: cmd, version };
}

/**
 * Prefer the REAL kilo binary (spawned directly, no shell) over the npm
 * .cmd/.ps1 shims: direct children have clean pids, clean stdio, and clean
 * tree-kills. Falls back to the PATH shim (shell:true on Windows) when no
 * binary is found (installer/curl put `kilo` directly on PATH).
 *
 * Resolution order (first hit wins):
 *  1. Packaged app resources: <resources>/vendor/kilo/<plat>-<arch>/kilo(.exe)
 *  2. Dev vendor dir (scripts/fetch-kilo.js): <app>/vendor/kilo/…/
 *  3. npm global: <prefix>/node_modules/@kilocode/cli/node_modules/@kilocode/
 *     cli-<plat>-<arch>/bin/kilo(.exe) (and the JS launcher next to it)
 *  4. Whatever `where`/`which` finds.
 *  5. Home-level installs (~/.kilo/bin).
 */
async function resolveCommand() {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const vendored = path.join('vendor', 'kilo', `${PLATFORM}-${process.arch}`, EXE);
  const here = path.dirname(fileURLToPath(import.meta.url)); // electron/main
  const candidates = [
    // 1) packaged app resources
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, vendored) : '',
    // 2) dev checkout after `npm run fetch:kilo`
    path.resolve(here, '..', '..', vendored),
  ];
  // 3) npm global root: <prefix>/node_modules/@kilocode/cli/...
  const npmRoot = await runCapture(isWin ? 'npm.cmd' : 'npm', ['root', '-g']);
  if (npmRoot.ok && npmRoot.stdout.trim()) {
    const root = npmRoot.stdout.trim();
    candidates.push(path.join(root, '@kilocode', 'cli', 'node_modules', '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
    candidates.push(path.join(root, '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
  }
  // Well-known npm prefix on Windows.
  if (isWin && process.env.APPDATA) {
    const nm = path.join(process.env.APPDATA, 'npm', 'node_modules');
    candidates.push(path.join(nm, '@kilocode', 'cli', 'node_modules', '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
    candidates.push(path.join(nm, '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
  }
  // Whatever `where`/`which` finds: accept a real binary, and for shims look
  // for the package binary next to them.
  const located = await runCapture(isWin ? 'where' : 'which', ['kilo']);
  if (located.ok) {
    for (const line of located.stdout.split(/\r?\n/)) {
      const p = line.trim().replace(/^"|"$/g, '');
      if (!p) continue;
      if (/\.exe$/i.test(p)) candidates.push(p);
      const dir = path.dirname(p);
      candidates.push(path.join(dir, 'node_modules', '@kilocode', 'cli', 'node_modules', '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
      candidates.push(path.join(dir, '..', 'node_modules', '@kilocode', `cli-${PLATFORM}-${process.arch}`, 'bin', EXE));
    }
  }
  // Home-level installs (Kilo docs mention ~/.kilo/bin).
  candidates.push(path.join(os.homedir(), '.kilo', 'bin', EXE));
  candidates.push(path.join(os.homedir(), '.opencode', 'bin', EXE)); // legacy fallback
  for (const c of candidates) {
    if (!c) continue; // no resourcesPath in this runtime — never resolve CWD
    try {
      const abs = path.resolve(c);
      const st = await fs.stat(abs);
      if (!st.isFile()) continue; // a matching directory is not a binary
      return abs;
    } catch {
      /* try next */
    }
  }
  return 'kilo'; // PATH shim fallback (needs shell on Windows)
}

/** True when `command` is a direct binary (no shell wrapper needed). */
export function isDirectBinary(command) {
  return command !== 'kilo' && !/\.(cmd|ps1|bat)$/i.test(command);
}

/** Auth header for the kilo server (Basic when password env is set, else none).
 *  KILO_SERVER_* is canonical; OPENCODE_SERVER_* is honored for back-compat. */
export function serverAuthHeader() {
  const password = process.env.KILO_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.KILO_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || 'kilo';
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
      // not stall the loop past the overall deadline.
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
  throw new Error(`Timed out waiting for \`kilo serve\` on port ${port} (${lastErr}).`);
}

/**
 * Start `kilo serve` rooted at `cwd` (0 = pick a free port).
 * extraEnv merges over process.env (used for Barang's managed MCP file).
 * Returns { base, port, version, cliVersion, child, stop }.
 */
export async function startKiloServer({ cwd, port = 0, onLog = () => {}, extraEnv = {} }) {
  const found = await findKilo();
  const listenPort = port || (await freePort());
  const direct = isDirectBinary(found.command);
  const bundled = found.command.toLowerCase().includes('vendor');
  const child = spawn(found.command, ['serve', '--port', String(listenPort), '--hostname', '127.0.0.1'], {
    cwd,
    shell: direct ? false : isWin, // shims need a shell; a real binary must NOT get one
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  onLog(`[barang] kilo: ${found.command} (pid ${child.pid}, direct=${direct}, bundled=${bundled})`);
  child.stdout?.on('data', (d) => onLog('[kilo] ' + d));
  child.stderr?.on('data', (d) => onLog('[kilo] ' + d));
  child.on('error', (e) => onLog('[kilo:error] ' + e.message));

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

// Back-compat alias: older imports referenced startOpencodeServer.
export const startOpencodeServer = startKiloServer;