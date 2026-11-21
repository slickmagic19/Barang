// Headless UI verification for the full Account section:
// sign-in (browser + key), sign-up, sign-out, device-prompt panel.
//
// Run: electron scripts/verify-account-ui.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const DIST = path.join(__dirname, '..', 'web', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.cjs');
const OUT = path.join(app.getPath('temp'), 'barang-account-ui.png');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[verify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

app.commandLine.appendSwitch('headless');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadFile(DIST);
  await new Promise((r) => setTimeout(r, 3500));

  const bridge = await win.webContents.executeJavaScript(`(() => {
    const b = window.barang;
    return {
      hasStatus: !!(b && b.auth && typeof b.auth.status === 'function'),
      hasLogin: !!(b && b.auth && typeof b.auth.login === 'function'),
      hasLoginKey: !!(b && b.auth && typeof b.auth.loginKey === 'function'),
      hasSignup: !!(b && b.auth && typeof b.auth.signup === 'function'),
      hasLogout: !!(b && b.auth && typeof b.auth.logout === 'function'),
      hasProgress: !!(b && b.auth && typeof b.auth.onLoginProgress === 'function'),
    };
  })()`).catch((e) => ({ evalError: e.message }));

  check('renderer auth bridge: status/login/loginKey/signup/logout/progress',
    bridge.hasStatus && bridge.hasLogin && bridge.hasLoginKey && bridge.hasSignup && bridge.hasLogout && bridge.hasProgress,
    bridge.evalError || JSON.stringify(bridge));

  const dom = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const gear = q('.settings-btn, .topbar .icon-btn[title*="Settings" i]');
    if (gear) gear.click();
    for (let i = 0; i < 20 && !q('.settings-overlay'); i++) await wait(100);
    if (!q('.settings-overlay')) return { opened: false };
    const navBtns = [...document.querySelectorAll('.settings-nav-item')];
    const acctNav = navBtns.find((b) => /^Account$/i.test(b.textContent.trim()));
    if (acctNav) acctNav.click();
    await wait(500);
    const page = q('.settings-page[data-section="Account"]');
    return {
      opened: true,
      navCount: navBtns.length,
      acctVisible: page ? page.getBoundingClientRect().height > 0 : false,
      hasBox: !!q('.account-box'),
      card: !!q('.account-card'),
      form: !!q('.account-form'),
      primary: !!q('.account-primary'),
      browserBtn: [...document.querySelectorAll('.account-primary .btn')].some((b) => /^sign in$/i.test(b.textContent.trim())),
      signupBtn: [...document.querySelectorAll('.account-primary .btn')].some((b) => /create account/i.test(b.textContent.trim())),
      keyToggle: [...document.querySelectorAll('.account-form .link-btn')].some((b) => /api key/i.test(b.textContent)),
      signOut: !!(q('.account-card') && [...q('.account-card').querySelectorAll('button')].some((b) => /sign out/i.test(b.textContent))),
      note429: [...document.querySelectorAll('.settings-note')].some((p) => /429/.test(p.textContent)),
      cardText: q('.account-card') ? q('.account-card').textContent.trim().slice(0, 80) : null,
    };
  })()`).catch((e) => ({ evalError: e.message }));

  if (dom.evalError) {
    check('settings dom eval', false, dom.evalError);
  } else {
    check('settings opens', dom.opened === true);
    check('Account nav section visible', dom.navCount >= 13 && dom.acctVisible, `nav=${dom.navCount} visible=${dom.acctVisible}`);
    check('Account box renders', dom.hasBox === true);
    check('renders signed-in card OR sign-out form', dom.card === true || dom.form === true,
      dom.card ? `card: ${dom.cardText}` : 'form');
    if (dom.form) {
      check('primary Sign in + Create account buttons', dom.browserBtn === true && dom.signupBtn === true);
      check('collapsible API-key option', dom.keyToggle === true);
    }
    if (dom.card) check('signed-in card has Sign out', dom.signOut === true);
    check('explains the 429 limit', dom.note429 === true);
  }

  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(OUT, img.toPNG());
    check('screenshot', fs.existsSync(OUT) && fs.statSync(OUT).size > 1000, OUT);
  } catch (e) { check('screenshot', false, e.message); }

  const failed = results.filter((r) => !r.ok);
  console.log(`[verify] ${results.length - failed.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 300));
  app.exit(failed.length === 0 ? 0 : 1);
});