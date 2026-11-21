// KiloCode account authentication for the desktop shell.
//
// The Kilo provider (Kilo Gateway) authenticates via a JWT API key. Kilo Code
// reads it from the KILO_API_KEY env var (provider `env: ["KILO_API_KEY"]`).
// Anonymous access works for free models only and is rate-limited to 200 req/hr
// per IP — which is exactly the 429 users hit when they are not signed in.
//
// Barang therefore stores the user's key and injects it into the kilo server's
// env (see mcpEnv() in index.js). The key lives in Barang's own file under
// userData, never in the project or in the shared barang.json. Users obtain a
// key from https://app.kilo.ai (Profile → API key), or sign in via the browser
// device flow (https://app.kilo.ai) — this module owns only the key path.
//
// Everything here is pure except the fs helpers, so it unit-tests without
// Electron. The IPC layer (index.js) is the only impure caller.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Absolute path of Barang's stored Kilo API key (userData/auth.json). */
export function authFilePath(userDataDir) {
  return path.join(userDataDir, 'auth.json');
}

/** Read the stored key, or '' when none. Never throws on missing/corrupt. */
export async function readStoredKey(userDataDir) {
  try {
    const raw = await fs.readFile(authFilePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.kiloApiKey === 'string' ? parsed.kiloApiKey : '';
  } catch {
    return '';
  }
}

/** Persist the key (atomic temp+rename). Empty string clears instead. */
export async function writeStoredKey(userDataDir, key) {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean) return clearStoredKey(userDataDir);
  const p = authFilePath(userDataDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ kiloApiKey: clean }), 'utf8');
  await fs.rename(tmp, p);
  return clean;
}

/** Remove the stored key. Safe when nothing is stored. */
export async function clearStoredKey(userDataDir) {
  try {
    await fs.unlink(authFilePath(userDataDir));
  } catch {
    /* not present */
  }
}

/** Merge the stored key into server env so `kilo serve` authenticates.
 *  KILO_API_KEY is the provider's own env var; an existing value (user-set)
 *  wins so Barang never overrides an explicit env. */
export function authEnv(storedKey, baseEnv = {}) {
  if (baseEnv.KILO_API_KEY || baseEnv.KILOCODE_API_KEY) return baseEnv;
  if (!storedKey) return baseEnv;
  return { ...baseEnv, KILO_API_KEY: storedKey };
}

/**
 * Parse `kilo profile --json` output into a status object.
 *  - exit 0 + JSON  → { loggedIn: true, name, email, team, balance }
 *  - non-zero / junk → { loggedIn: false }
 * Tolerant of banner/log noise around the JSON (take the first {...} block).
 */
export function parseAuthStatus(stdout, exitCode) {
  if (exitCode !== 0) return { loggedIn: false };
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { loggedIn: false };
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    // A profile with no name is not a real sign-in.
    if (!obj || typeof obj.name !== 'string' || !obj.name) return { loggedIn: false };
    return {
      loggedIn: true,
      name: obj.name,
      email: typeof obj.email === 'string' ? obj.email : '',
      team: typeof obj.team === 'string' ? obj.team : '',
      balance: typeof obj.balance === 'number' ? obj.balance : null,
    };
  } catch {
    return { loggedIn: false };
  }
}

/** Normalize a pasted key: trim, collapse whitespace, basic JWT shape check. */
export function normalizeKey(raw) {
  const k = String(raw || '').trim().replace(/\s+/g, '');
  return k;
}

/** True when `k` looks like a Kilo Gateway JWT (three dot-separated segments). */
export function isKeyLike(k) {
  return typeof k === 'string' && k.length >= 20 && k.split('.').length >= 2;
}

/** Public-facing status from a parsed profile, for the renderer. */
export function publicStatus(parsed) {
  if (!parsed || !parsed.loggedIn) {
    return { loggedIn: false, name: '', email: '', team: '', balance: null };
  }
  return {
    loggedIn: true,
    name: parsed.name || '',
    email: parsed.email || '',
    team: parsed.team || '',
    balance: typeof parsed.balance === 'number' ? parsed.balance : null,
  };
}

/**
 * Parse the Kilo device-authorization prompt from `kilo auth login` output.
 * The CLI prints:
 *   Go to: https://app.kilo.ai/device-auth?code=3ZEA-RNDF
 *   Open https://app.kilo.ai/device-auth?code=3ZEA-RNDF and enter code: <token>
 * Returns { url, code } (both may be '' before the prompt appears).
 * Tolerant of ANSI escapes and spinner noise.
 */
export function parseDeviceAuth(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const urlM = /https:\/\/[^\s]*\/device-auth\?code=([A-Za-z0-9-]+)/.exec(text);
  const url = urlM ? urlM[0] : '';
  // The user-facing short code is the `code=` query param (e.g. 3ZEA-RNDF).
  const shortCode = urlM ? urlM[1] : '';
  // The long token to type into the browser, if present.
  const tokenM = /enter code:\s*([A-Za-z0-9_-]+)/.exec(text);
  const token = tokenM ? tokenM[1] : '';
  return { url, code: shortCode, token };
}

/** Account links shown in the login / sign-up UI. */
export const ACCOUNT_LINKS = {
  key: 'https://app.kilo.ai/profile',
  signIn: 'https://app.kilo.ai',
  signUp: 'https://app.kilo.ai/',
  deviceAuth: 'https://app.kilo.ai/device-auth',
  docs: 'https://kilo.ai/docs/getting-started/setup-authentication',
};

/** True when a kilo auth.json has a real Kilo Gateway credential. */
export function hasStoredCredential(authJson) {
  try {
    const obj = typeof authJson === 'string' ? JSON.parse(authJson) : authJson;
    const k = obj?.kilo;
    if (!k || typeof k !== 'object') return false;
    // OAuth (access/refresh) or an api key both count.
    return !!(k.access || k.refresh || k.key);
  } catch {
    return false;
  }
}