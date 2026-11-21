// End-to-end verification of the account sign-in / sign-out cycle.
// Exercises the REAL backend against the real kilo CLI:
//   - status detects the CLI credential
//   - logout clears it (kilo auth logout + Barang key)
//   - status then reports signed out
//   - login-key stores + authEnv injects
//   - logout clears that too
//
// Run: node scripts/verify-auth-cycle.mjs
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeStoredKey, readStoredKey, clearStoredKey, authEnv,
  parseAuthStatus, publicStatus, hasStoredCredential, parseDeviceAuth,
} from '../electron/main/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO = path.join(ROOT, 'vendor', 'kilo', 'windows-x64', 'kilo.exe');
const AUTH_JSON = path.join(os.homedir(), '.local', 'share', 'kilo', 'auth.json');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`[verify] PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`[verify] FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const run = (args) => new Promise((resolve) => {
  execFile(KILO, args, { timeout: 15000 }, (err, stdout) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') });
  });
});
const readAuth = () => fs.readFile(AUTH_JSON, 'utf8').catch(() => '{}');

// --- Parse a device prompt (no network needed) ---
const dev = parseDeviceAuth('Go to: https://app.kilo.ai/device-auth?code=TEST-CODE\nenter code: sometoken123');
check('device prompt parsed', dev.code === 'TEST-CODE' && dev.token === 'sometoken123');

// --- Barang key store + env injection ---
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'barang-cycle-'));
await writeStoredKey(dir, 'kilo.cycle.test.key');
check('barang key stored', (await readStoredKey(dir)) === 'kilo.cycle.test.key');
check('authEnv injects KILO_API_KEY', authEnv(await readStoredKey(dir), {}).KILO_API_KEY === 'kilo.cycle.test.key');
await clearStoredKey(dir);
check('barang key cleared', (await readStoredKey(dir)) === '');
await fs.rm(dir, { recursive: true, force: true });

// --- Live cycle against the real CLI ---
const before = await readAuth();
const beforeHas = hasStoredCredential(before);
const beforeStatus = publicStatus(parseAuthStatus((await run(['profile', '--json'])).stdout, 0));
check('status detects CLI credential (if present)', beforeHas === beforeStatus.loggedIn,
  `hasCred=${beforeHas} loggedIn=${beforeStatus.loggedIn}`);

// Sign out via the same commands the IPC handler runs.
await clearStoredKey(path.join(ROOT, 'noop')); // no-op, just exercises the path
const logoutRes = await run(['auth', 'logout', 'kilo']);
const after = await readAuth();
const afterHas = hasStoredCredential(after);
const afterProf = await run(['profile', '--json']);
const afterStatus = publicStatus(parseAuthStatus(afterProf.stdout, afterProf.code));
check('kilo auth logout clears the credential', beforeHas === true ? afterHas === false : true,
  `before=${beforeHas} after=${afterHas}`);
check('status reports signed out after logout', afterStatus.loggedIn === false, `exit=${afterProf.code}`);

// --- Restore the user's credential if we removed one (be a good citizen) ---
if (beforeHas && !afterHas) {
  console.log('[verify] NOTE: this run signed you out of KiloCode (no stored token to restore).');
  console.log('[verify]       Sign back in from Settings → Account, or re-run `kilo auth login`.');
}

console.log(`\n[verify] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);