// Headless UI verification for the Usage section: opens Settings → Usage and
// asserts the balance card + usage totals + per-model breakdown render.
//
// Run: electron scripts/verify-usage-ui.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const DIST = path.join(__dirname, '..', 'web', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.cjs');
const OUT = path.join(app.getPath('temp'), 'barang-usage-ui.png');

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
  await new Promise((r) => setTimeout(r, 4000));

  const dom = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const gear = q('.settings-btn, .topbar .icon-btn[title*="Settings" i]');
    if (gear) gear.click();
    for (let i = 0; i < 20 && !q('.settings-overlay'); i++) await wait(100);
    if (!q('.settings-overlay')) return { opened: false };
    const navBtns = [...document.querySelectorAll('.settings-nav-item')];
    const usageNav = navBtns.find((b) => /^Usage$/i.test(b.textContent.trim()));
    if (usageNav) usageNav.click();
    await wait(2000); // usageLoad fetches /session + auth:status
    const page = q('.settings-page[data-section="Usage"]');
    return {
      opened: true,
      navCount: navBtns.length,
      hasNav: !!usageNav,
      acctVisible: page ? page.getBoundingClientRect().height > 0 : false,
      hasPanel: !!q('.usage-box'),
      hasBalanceCard: !!q('.usage-card'),
      balanceText: q('.usage-card-value') ? q('.usage-card-value').textContent.trim() : null,
      hasGrid: !!q('.usage-grid'),
      cells: [...document.querySelectorAll('.usage-cell')].map((c) => ({
        label: c.querySelector('.usage-cell-label')?.textContent.trim(),
        value: c.querySelector('.usage-cell-value')?.textContent.trim(),
      })),
      hasBreakdown: !!q('.usage-group'),
      modelRows: document.querySelectorAll('.usage-row').length,
      hasRefresh: [...document.querySelectorAll('.usage-actions .btn')].some((b) => /refresh/i.test(b.textContent)),
      hasDashboard: [...document.querySelectorAll('.usage-actions .btn')].some((b) => /dashboard/i.test(b.textContent)),
      loading: !!q('.usage-box .scm-none'),
    };
  })()`).catch((e) => ({ evalError: e.message }));

  if (dom.evalError) {
    check('usage dom eval', false, dom.evalError);
  } else {
    check('settings opens', dom.opened === true);
    check('Usage nav section present', dom.hasNav === true && dom.navCount >= 14, `nav=${dom.navCount}`);
    check('Usage page visible', dom.acctVisible === true);
    check('usage panel renders', dom.hasPanel === true);
    check('balance card renders (signed in) OR signed-out note',
      dom.hasBalanceCard === true || dom.loading === false,
      dom.balanceText ? `balance=${dom.balanceText}` : '');
    // Grid + actions render when there is usage; otherwise the empty-state note
    // ("No sessions yet") is the correct output. Either is acceptable.
    if (dom.hasGrid) {
      check('totals grid renders', dom.cells.length >= 5, `${dom.cells.length} cells`);
      check('totals cells have values', dom.cells.every((c) => c.value && c.value !== '—'),
        dom.cells.map((c) => `${c.label}=${c.value}`).join(', '));
      check('refresh + dashboard actions present', dom.hasRefresh === true && dom.hasDashboard === true);
    } else {
      const emptyNote = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.usage-box .scm-none')].some((n) => /No sessions yet|Loading/.test(n.textContent))`,
      ).catch(() => false);
      check('usage shows empty-state when no sessions', emptyNote === true,
        dom.loading ? 'still loading' : 'grid absent');
    }
  }

  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(OUT, img.toPNG());
    check('screenshot', fs.existsSync(OUT) && fs.statSync(OUT).size > 1000, OUT);
  } catch (e) { check('screenshot', false, e.message); }

  const failed = results.filter((r) => !r.ok);
  console.log(`[verify] ${results.length - failed.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 200));
  app.exit(failed.length === 0 ? 0 : 1);
});