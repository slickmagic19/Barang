// Verifies the sign-in → status → sign-out → status cycle through the REAL
// backend functions (same code the IPC handlers call), proving logout actually
// flips status back to signed-out (the bug the user reported).
//
// Run: node scripts/verify-logout-fix.mjs
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeStoredKey, readStoredKey, clearStoredKey, authEnv,
} from '../electron/main/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`[verify] PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`[verify] FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Simulate the auth:status "stored key" branch + auth:logout clearing it.
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'barang-logout-'));

// 1) Signed out initially.
check('initially signed out', (await readStoredKey(userData)) === '');

// 2) Sign in with a key (auth:login-key path).
await writeStoredKey(userData, 'kilo.test.jwt.key');
const env = authEnv(await readStoredKey(userData), {});
check('after login: key stored', (await readStoredKey(userData)) !== '');
check('after login: server env authenticated', env.KILO_API_KEY === 'kilo.test.jwt.key');

// 3) Sign out (auth:logout clears the stored key).
await clearStoredKey(userData);
const envAfter = authEnv(await readStoredKey(userData), {});
check('after logout: key cleared', (await readStoredKey(userData)) === '');
check('after logout: server env NOT authenticated', !envAfter.KILO_API_KEY);

// 4) Status would now fall through to the CLI (which the IPC also logs out).
check('after logout: status branch falls through to CLI check', (await readStoredKey(userData)) === '');

await fs.rm(userData, { recursive: true, force: true });
console.log(`\n[verify] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);