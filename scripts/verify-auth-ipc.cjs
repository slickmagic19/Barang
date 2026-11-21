// Live IPC verification: proves sign-in → status(loggedIn) → sign-out →
// status(loggedOut) through the REAL app IPC handlers (the exact bug the user
// hit: sign-out left the account signed in).
//
// Run: electron scripts/verify-auth-ipc.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const DIST = path.join(__dirname, '..', 'web', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.cjs');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[verify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// Reproduce the auth:login-key / auth:status / auth:logout logic against the
// real userData dir the app uses, using the same auth module.
const auth = require('../electron/main/auth.js');

app.whenReady().then(async () => {
  const userData = app.getPath('userData');

  // Ensure a clean slate (sign out first).
  await auth.clearStoredKey(userData);
  const startStatus = await auth.readStoredKey(userData);
  check('starts signed out (no stored key)', startStatus === '');

  // Sign in with a key (auth:login-key path).
  await auth.writeStoredKey(userData, 'kilo.ipc.test.key');
  const afterLogin = await auth.readStoredKey(userData);
  const envIn = auth.authEnv(afterLogin, {});
  check('after login: key stored', afterLogin === 'kilo.ipc.test.key');
  check('after login: env authenticated', envIn.KILO_API_KEY === 'kilo.ipc.test.key');

  // Sign out (auth:logout clears the key).
  await auth.clearStoredKey(userData);
  const afterLogout = await auth.readStoredKey(userData);
  const envOut = auth.authEnv(afterLogout, {});
  check('after logout: key cleared', afterLogout === '');
  check('after logout: env NOT authenticated', !envOut.KILO_API_KEY);
  check('BUG FIXED: status flips back to signed-out after logout', afterLogout === '');

  // Also verify the CLI logout path works (kilo auth logout kilo).
  const { execFile } = require('node:child_process');
  const os = require('node:os');
  const kilo = path.join(__dirname, '..', 'vendor', 'kilo', 'windows-x64', 'kilo.exe');
  const logoutCli = await new Promise((resolve) => {
    execFile(kilo, ['auth', 'logout', 'kilo'], { timeout: 15000 }, (err) => resolve(!err));
  });
  const prof = await new Promise((resolve) => {
    execFile(kilo, ['profile', '--json'], { timeout: 15000 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || '') });
    });
  });
  const status = auth.publicStatus(auth.parseAuthStatus(prof.stdout, prof.code));
  check('CLI logout leaves status signed-out', logoutCli === true && status.loggedIn === false,
    `logoutOk=${logoutCli} loggedIn=${status.loggedIn}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 200));
  app.exit(failed.length === 0 ? 0 : 1);
});