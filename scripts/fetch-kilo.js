// Vendors the Kilo Code CLI binary into vendor/ so the installer ships it and
// Barang works out of the box (no separate Kilo install needed).
// Source: Kilo's own per-platform npm packages, e.g.
//   @kilocode/cli-windows-x64@7.8.27 -> package bin/kilo.exe
// Kilo Code is an OpenCode fork, so `kilo serve` exposes the same local API
// Barang already drives.
// Usage: node scripts/fetch-kilo.js [--version 7.8.27] [--platform win32] [--arch x64]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(here, '..', 'vendor', 'kilo');

const args = process.argv.slice(2);
const pick = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VERSION = pick('--version', process.env.BARANG_KILO_VERSION || '7.8.27');
const PLATFORM = pick('--platform', os.platform()); // win32 | darwin | linux
const ARCH = pick('--arch', os.arch()); // x64 | arm64

const platformMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const platform = platformMap[PLATFORM] ?? PLATFORM;
const pkg = `@kilocode/cli-${platform}-${ARCH}`;
const exeName = platform === 'windows' ? 'kilo.exe' : 'kilo';
const destDir = path.join(VENDOR_DIR, `${platform}-${ARCH}`);
const dest = path.join(destDir, exeName);

function sh(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`Command failed: ${cmd} ${cmdArgs.join(' ')}`);
}

function main() {
  if (fs.existsSync(dest)) {
    const v = spawnSync(dest, ['--version'], { encoding: 'utf8' });
    if (v.status === 0 && String(v.stdout || '').includes(VERSION)) {
      console.log(`[vendor] kilo ${VERSION} already vendored at ${dest}`);
      return;
    }
    fs.rmSync(dest, { force: true });
  }
  console.log(`[vendor] fetching ${pkg}@${VERSION} from npm…`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barang-kilo-'));
  try {
    sh('npm', ['install', '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', tmp, `${pkg}@${VERSION}`], process.cwd());
    const src = path.join(tmp, 'node_modules', '@kilocode', `cli-${platform}-${ARCH}`, 'bin', exeName);
    if (!fs.existsSync(src)) throw new Error(`Binary not found in package: ${src}`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const v = spawnSync(dest, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0 || !String(v.stdout || '').includes(VERSION)) {
    throw new Error(`Vendored binary failed verification: ${dest}`);
  }
  const size = (fs.statSync(dest).size / 1048576).toFixed(1);
  console.log(`[vendor] OK: ${dest} (${size} MB, ${(v.stdout || '').trim()})`);
}

main();