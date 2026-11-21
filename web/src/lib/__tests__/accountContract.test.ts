// Account (KiloCode sign-in) UI contract.
//
// There is no headless browser here, so the invariants that would otherwise
// regress silently — the Account section existing in Settings, the auth bridge
// being exposed end-to-end (preload → transport type → settings call), and the
// login/sign-out wiring — are pinned against the source files.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const settings = read('../../ui/settings.ts');
const preload = read('../../../../electron/preload.cjs');
const transport = read('../transport.ts');
const css = read('../../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

describe('Settings exposes an Account section', () => {
  it('registers Account as the first nav section', () => {
    const m = /const SECTIONS = \[([^\]]+)\]/.exec(settings);
    expect(m).toBeTruthy();
    const sections = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(sections[0]).toBe('Account');
  });

  it('builds a section("Account") page with login/signup UI', () => {
    expect(settings).toMatch(/section\('Account'\)/);
    // Status/login/logout/signup go through the auth bridge.
    expect(settings).toContain('barang().auth.status');
    expect(settings).toContain('barang().auth.login(');
    expect(settings).toContain('barang().auth.loginKey(');
    expect(settings).toContain('barang().auth.signup');
    expect(settings).toContain('barang().auth.logout');
  });

  it('offers an API-key input and a link to the Kilo profile', () => {
    expect(settings).toMatch(/account-key-input/);
    expect(settings).toContain('app.kilo.ai/profile');
  });

  it('explains the 429 rate limit so users know why to sign in', () => {
    expect(settings).toContain('429');
  });
});

describe('auth bridge is exposed end-to-end', () => {
  it('preload exposes barang.auth.{status,login,loginKey,signup,logout}', () => {
    expect(preload).toMatch(/auth:\s*\{/);
    expect(preload).toContain("invoke('auth:status')");
    expect(preload).toContain("invoke('auth:login-start')");
    expect(preload).toContain("invoke('auth:login-key'");
    expect(preload).toContain("invoke('auth:signup')");
    expect(preload).toContain("invoke('auth:logout')");
    expect(preload).toContain("auth:login-progress");
  });

  it('transport type declares the auth surface', () => {
    expect(transport).toMatch(/auth:\s*\{/);
    expect(transport).toContain('status():');
    expect(transport).toContain('login(opts');
    expect(transport).toContain('loginKey(key: string)');
    expect(transport).toContain('signup():');
    expect(transport).toContain('logout():');
  });
});

describe('account styles exist', () => {
  for (const cls of ['.account-box', '.account-card', '.account-avatar', '.account-form', '.account-key-input']) {
    it(`defines ${cls}`, () => {
      expect(css).toContain(cls);
    });
  }
});

describe('backend wiring', () => {
  const index = read('../../../../electron/main/index.js');
  const authJs = read('../../../../electron/main/auth.js');

  it('main registers auth handlers', () => {
    expect(index).toContain("ipcMain.handle('auth:status'");
    expect(index).toContain("ipcMain.handle('auth:login-start'");
    expect(index).toContain("ipcMain.handle('auth:login-key'");
    expect(index).toContain("ipcMain.handle('auth:logout'");
    expect(index).toContain("ipcMain.handle('auth:signup'");
  });

  it('main injects the stored key into the kilo server env', () => {
    expect(index).toContain('auth.readStoredKey');
    expect(index).toContain('auth.authEnv');
  });

  it('sign-out clears the CLI credential too (kilo auth logout)', () => {
    expect(index).toContain("'logout', 'kilo'");
  });

  it('auth module owns the key store + status parsing', () => {
    expect(authJs).toContain('export function parseAuthStatus');
    expect(authJs).toContain('writeStoredKey');
    expect(authJs).toContain('KILO_API_KEY');
  });
});