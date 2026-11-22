// E2E: send a real chat in the headless app and measure how long the busy
// indicator stays after the assistant reply appears. Proves the heartbeat
// clears "Agent working…" promptly instead of sticking.
//
// Run: electron scripts/verify-busy-clear.cjs
const path = require('node:path');
const { app } = require('electron');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[verify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
app.commandLine.appendSwitch('headless');

app.whenReady().then(async () => {
  require('../electron/main/index.js');
  const { BrowserWindow } = require('electron');
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    await new Promise((r) => setTimeout(r, 500));
    win = BrowserWindow.getAllWindows()[0] || null;
  }
  if (!win) { console.log('no window'); app.exit(1); return; }
  try {
    await win.webContents.executeJavaScript(`window.barang.app.openPath(${JSON.stringify(process.cwd())})`);
  } catch {}
  // Server boot + meta/session load.
  await new Promise((r) => setTimeout(r, 13000));

  // Send a trivial prompt via the composer.
  const sent = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const input = q('.composer-input');
    const send = q('.send-row .btn-primary');
    if (!input || !send) return { ok: false, reason: 'no composer' };
    input.focus();
    input.value = 'Reply with exactly the word PONG and nothing else.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    const before = document.querySelectorAll('.msg.is-agent').length;
    send.click();
    return { ok: true, before };
  })()`).catch((e) => ({ evalError: e.message }));

  if (!sent.ok) { check('composer send', false, sent.reason || sent.evalError); app.exit(1); return; }
  check('composer send dispatched', sent.ok === true);

  // Report the active model + connection state first.
  const env = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const mini = q('.model-mini');
    const conn = q('.conn-banner, .offline-banner');
    return {
      model: mini ? (mini.value || mini.options?.[mini.selectedIndex]?.text || '') : '(none)',
      connected: !!(conn && conn.classList.contains('hidden')),
    };
  })()`).catch(() => ({}));
  console.log('[verify] model:', env.model, 'connected:', env.connected);

  // Poll for the assistant reply + busy-row state.
  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const beforeCount = sent.before || 0;
  let agentTextAt = null;
  let busyHiddenAt = null;
  let busySeen = false;
  let lastBusy = null;
  let lastText = '';
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const snap = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const busy = q('.busy-row');
      const busyVisible = busy ? !busy.classList.contains('hidden') : false;
      const busyText = busy ? (busy.textContent || '').trim() : '';
      const agents = [...document.querySelectorAll('.msg.is-agent')];
      const runErr = q('.msg-runerr');
      return { busyVisible, busyText, agentCount: agents.length, runErr: runErr ? (runErr.textContent || '').slice(0, 120) : '' };
    })()`).catch(() => ({}));
    if (snap.runErr) console.log(el() + 's run error:', snap.runErr);
    if (snap.busyText && snap.busyText !== lastText) { console.log(el() + 's busy:', snap.busyText.slice(0, 60)); lastText = snap.busyText; }
    if (snap.busyVisible) { busySeen = true; lastBusy = true; }
    else if (busySeen && lastBusy) { busyHiddenAt = Date.now(); lastBusy = false; }
    if (agentTextAt === null && snap.agentCount > beforeCount) {
      agentTextAt = Date.now();
      console.log(el() + 's new assistant message appeared (count ' + snap.agentCount + ')');
    }
    if (agentTextAt && busyHiddenAt) break;
    if (i === 199) console.log(el() + 's timeout (busyText="' + lastText + '")');
  }

  if (agentTextAt) console.log('assistant text at', ((agentTextAt - t0) / 1000).toFixed(1) + 's');
  if (busyHiddenAt) console.log('busy hidden at   ', ((busyHiddenAt - t0) / 1000).toFixed(1) + 's');

  check('agent produced a reply', agentTextAt !== null);
  check('busy indicator appeared during the run', busySeen === true);
  if (agentTextAt && busyHiddenAt) {
    const gap = (busyHiddenAt - agentTextAt) / 1000;
    console.log('gap (assistant text → busy hidden):', gap.toFixed(1) + 's');
    check('busy clears promptly after the reply (<6s)', gap < 6, gap.toFixed(1) + 's');
  } else if (agentTextAt && !busyHiddenAt) {
    check('busy clears after the reply', false, 'busy never hidden within 30s');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[verify] ${results.length - failed.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 200));
  app.exit(failed.length === 0 ? 0 : 1);
});