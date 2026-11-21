// KiloCode account auth — pure-logic tests.
//
// The auth module (electron/main/auth.js) owns everything except the IPC
// shell: storing/reading the API key, merging it into the server env, and
// parsing `kilo profile --json` into a status object. These tests pin that
// logic without Electron or a real kilo binary.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authFilePath, readStoredKey, writeStoredKey, clearStoredKey,
  authEnv, parseAuthStatus, normalizeKey, isKeyLike, publicStatus, ACCOUNT_LINKS,
  parseDeviceAuth, hasStoredCredential,
} from '../../../../electron/main/auth.js';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'barang-auth-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('authFilePath', () => {
  it('points at auth.json inside userData', () => {
    expect(authFilePath('/data')).toBe(path.join('/data', 'auth.json'));
  });
});

describe('stored key round-trip', () => {
  it('returns empty string when nothing is stored', async () => {
    expect(await readStoredKey(dir)).toBe('');
  });

  it('persists and reads back a key', async () => {
    await writeStoredKey(dir, '  kilo-abc-123  ');
    expect(await readStoredKey(dir)).toBe('kilo-abc-123');
  });

  it('trims and collapses whitespace in the stored key', async () => {
    await writeStoredKey(dir, '  a.b.c  ');
    expect(await readStoredKey(dir)).toBe('a.b.c');
  });

  it('clearing removes the file', async () => {
    await writeStoredKey(dir, 'k');
    await clearStoredKey(dir);
    expect(await readStoredKey(dir)).toBe('');
  });

  it('clearing when nothing stored is a no-op', async () => {
    await expect(clearStoredKey(dir)).resolves.toBeUndefined();
  });

  it('empty write clears instead of storing a blank key', async () => {
    await writeStoredKey(dir, 'k');
    await writeStoredKey(dir, '   ');
    expect(await readStoredKey(dir)).toBe('');
  });

  it('survives a corrupt file (returns empty)', async () => {
    await fs.writeFile(authFilePath(dir), '{not json', 'utf8');
    expect(await readStoredKey(dir)).toBe('');
  });
});

describe('authEnv', () => {
  it('injects KILO_API_KEY when a stored key exists', () => {
    expect(authEnv('KEY', {})).toEqual({ KILO_API_KEY: 'KEY' });
  });

  it('does not inject when no key', () => {
    expect(authEnv('', {})).toEqual({});
  });

  it('never overrides an explicit KILO_API_KEY', () => {
    expect(authEnv('BARANG', { KILO_API_KEY: 'USER' })).toEqual({ KILO_API_KEY: 'USER' });
  });

  it('never overrides KILOCODE_API_KEY', () => {
    expect(authEnv('BARANG', { KILOCODE_API_KEY: 'USER' })).toEqual({ KILOCODE_API_KEY: 'USER' });
  });

  it('preserves other env vars', () => {
    expect(authEnv('KEY', { KILO_CONFIG: '/x' })).toEqual({ KILO_CONFIG: '/x', KILO_API_KEY: 'KEY' });
  });
});

describe('parseAuthStatus', () => {
  it('parses a logged-in profile', () => {
    const out = JSON.stringify({ name: 'ada', email: 'ada@x.io', team: 'Personal', balance: 5 });
    expect(parseAuthStatus(out, 0)).toEqual({
      loggedIn: true, name: 'ada', email: 'ada@x.io', team: 'Personal', balance: 5,
    });
  });

  it('tolerates banner noise around the JSON', () => {
    const out = 'INFO starting\n{"name":"bob","email":"b@x.io"}\nDONE';
    const s = parseAuthStatus(out, 0);
    expect(s.loggedIn).toBe(true);
    expect(s.name).toBe('bob');
  });

  it('non-zero exit → not logged in', () => {
    expect(parseAuthStatus('Error: Not authenticated', 1).loggedIn).toBe(false);
  });

  it('empty output with exit 0 → not logged in', () => {
    expect(parseAuthStatus('', 0).loggedIn).toBe(false);
  });

  it('JSON without a name → not logged in', () => {
    expect(parseAuthStatus('{"email":"x"}', 0).loggedIn).toBe(false);
  });

  it('garbage → not logged in', () => {
    expect(parseAuthStatus('not json at all', 0).loggedIn).toBe(false);
  });

  it('defaults balance to null when absent', () => {
    expect(parseAuthStatus('{"name":"z"}', 0).balance).toBeNull();
  });
});

describe('normalizeKey / isKeyLike', () => {
  it('trims and strips internal whitespace', () => {
    expect(normalizeKey('  a b\nc ')).toBe('abc');
  });

  it('accepts JWT-shaped keys', () => {
    expect(isKeyLike('aaa.bbb.ccc')).toBe(false); // too short to be a real key
    expect(isKeyLike('eyJhbGciOi.J7abcD3.signaturevalue1234567890')).toBe(true);
    expect(isKeyLike('headerpayloadsection.anothersectionlongenough.sig')).toBe(true);
  });

  it('rejects short / non-JWT keys', () => {
    expect(isKeyLike('short')).toBe(false);
    expect(isKeyLike('')).toBe(false);
    expect(isKeyLike('nodotsherebutlongenoughvalue')).toBe(false);
  });
});

describe('publicStatus', () => {
  it('normalizes a logged-in profile for the renderer', () => {
    expect(publicStatus({ loggedIn: true, name: 'ada', email: 'a@x', team: 'T', balance: 3 }))
      .toEqual({ loggedIn: true, name: 'ada', email: 'a@x', team: 'T', balance: 3 });
  });

  it('returns a clean signed-out shape', () => {
    expect(publicStatus(null)).toEqual({ loggedIn: false, name: '', email: '', team: '', balance: null });
  });

  it('coerces a missing balance to null', () => {
    expect(publicStatus({ loggedIn: true, name: 'z' }).balance).toBeNull();
  });
});

describe('ACCOUNT_LINKS', () => {
  it('points at the Kilo profile / sign-in / docs', () => {
    expect(ACCOUNT_LINKS.key).toContain('app.kilo.ai');
    expect(ACCOUNT_LINKS.signIn).toContain('app.kilo.ai');
    expect(ACCOUNT_LINKS.signUp).toContain('app.kilo.ai');
    expect(ACCOUNT_LINKS.docs).toContain('kilo.ai/docs');
  });
});

describe('parseDeviceAuth', () => {
  it('extracts the URL, short code, and token from the CLI prompt', () => {
    const out = 'Go to: https://app.kilo.ai/device-auth?code=3ZEA-RNDF\n' +
      'Open https://app.kilo.ai/device-auth?code=3ZEA-RNDF and enter code: LcicDljkqY4EvhCHoDBXckltYX';
    const p = parseDeviceAuth(out);
    expect(p.url).toBe('https://app.kilo.ai/device-auth?code=3ZEA-RNDF');
    expect(p.code).toBe('3ZEA-RNDF');
    expect(p.token).toBe('LcicDljkqY4EvhCHoDBXckltYX');
  });

  it('tolerates ANSI escapes and spinner noise', () => {
    const out = '\x1b[90m│\x1b[39m\r\n\x1b[34m●\x1b[39m Go to: https://app.kilo.ai/device-auth?code=AB12-CD34\r\n';
    const p = parseDeviceAuth(out);
    expect(p.code).toBe('AB12-CD34');
    expect(p.url).toContain('device-auth');
  });

  it('returns empty fields before the prompt appears', () => {
    const p = parseDeviceAuth('Add credential…');
    expect(p.url).toBe('');
    expect(p.code).toBe('');
    expect(p.token).toBe('');
  });
});

describe('hasStoredCredential', () => {
  it('true for an oauth entry with access/refresh', () => {
    expect(hasStoredCredential('{"kilo":{"type":"oauth","access":"a","refresh":"r"}}')).toBe(true);
  });

  it('true for an api-key entry', () => {
    expect(hasStoredCredential('{"kilo":{"type":"api","key":"secret"}}')).toBe(true);
  });

  it('false for an empty object (signed out)', () => {
    expect(hasStoredCredential('{}')).toBe(false);
  });

  it('false for missing kilo provider', () => {
    expect(hasStoredCredential('{"anthropic":{}}')).toBe(false);
  });

  it('false for garbage', () => {
    expect(hasStoredCredential('not json')).toBe(false);
  });
});