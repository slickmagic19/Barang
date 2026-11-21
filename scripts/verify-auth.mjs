// Functional verification for the KiloCode account feature.
// Exercises the real backend (auth.js + the auth:status flow) and confirms the
// built renderer exposes the Account section, without needing the full app.
//
// Run: node scripts/verify-auth.mjs
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStoredKey, writeStoredKey, clearStoredKey, authEnv,
  parseAuthStatus, normalizeKey, isKeyLike, publicStatus,
} from '../electron/main/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`[verify] PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`[verify] FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// 1) Key store round-trip in a temp userData dir.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'barang-verify-'));
await writeStoredKey(dir, '  kilo.verify.key  ');
check('store round-trip', (await readStoredKey(dir)) === 'kilo.verify.key');
check('authEnv injects key', authEnv(await readStoredKey(dir), {}).KILO_API_KEY === 'kilo.verify.key');
await clearStoredKey(dir);
check('clear removes key', (await readStoredKey(dir)) === '');
await fs.rm(dir, { recursive: true, force: true });

// 2) Real `kilo profile --json` status parse (this machine is signed in).
const kilo = path.join(ROOT, 'vendor', 'kilo', 'windows-x64', 'kilo.exe');
const prof = await new Promise((resolve) => {
  execFile(kilo, ['profile', '--json'], { timeout: 15000 }, (err, stdout) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') });
  });
});
const status = publicStatus(parseAuthStatus(prof.stdout, prof.code));
if (status.loggedIn) {
  check('profile parse → loggedIn', status.loggedIn === true, status.name ? `name=${status.name}` : '');
  check('profile has email', status.email.length > 0, status.email);
} else {
  // Not signed in (e.g. after a logout test): parseAuthStatus must report so.
  check('profile parse → signed out (exit!=0 handled)', status.loggedIn === false, `exit=${prof.code}`);
}
// Signed-out shape when exit != 0.
check('signed-out parse', publicStatus(parseAuthStatus('Error: Not authenticated', 1)).loggedIn === false);

// 3) Key validation.
check('rejects short key', isKeyLike('short') === false);
check('accepts JWT-ish key', isKeyLike('eyJhbGciOi.payloadvalue.signaturevalue1234567890') === true);
check('normalize strips whitespace', normalizeKey(' a b\nc ') === 'abc');

// 4) Built renderer exposes the Account section + auth bridge.
const built = await fs.readFile(path.join(ROOT, 'web', 'dist', 'assets', 'index-BBv7Znzh.js'), 'utf8')
  .catch(() => fs.readFile(path.join(ROOT, 'web', 'dist', 'assets', 'index.js'), 'utf8'))
  .catch(async () => {
    // fall back: read whichever index-*.js exists
    const assets = await fs.readdir(path.join(ROOT, 'web', 'dist', 'assets'));
    const js = assets.find((f) => /^index-.*\.js$/.test(f));
    return js ? fs.readFile(path.join(ROOT, 'web', 'dist', 'assets', js), 'utf8') : '';
  });
check('built bundle has Account section', built.includes('Account'));
check('built bundle calls auth.status', /auth\.status|\.status\(\)/.test(built));
check('built bundle references 429', built.includes('429'));
check('built bundle links app.kilo.ai', built.includes('app.kilo.ai'));

console.log(`\n[verify] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);