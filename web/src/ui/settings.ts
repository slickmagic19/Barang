// Settings modal (topbar gear): everything adjustable in Barang.
// Sections: Model (free-only filter, Muse Spark default), Agent, Chat
// (reasoning visibility), Editor (font, minimap), Sessions (delete confirm),
// Layout (panel reset). Persisted to localStorage, applied immediately.
import {
  agentStore, loadMeta, readSettings, writeSettings, isFreeModel, pickDefaultModel,
  setAgent, listSelectableModels, applyModelSelection,
} from '../lib/agent';
import { appState } from '../lib/api';
import { barang } from '../lib/transport';
import { el } from '../lib/util';
import { iconEl } from './icons';
import { applyEditorPrefs } from './editor';
import { applyTerminalPrefs } from './terminal';
import { BUILTIN_SOUNDS, resolveSoundUrl, playNotificationSound } from '../lib/notify';
import logoUrl from '../assets/barang-logo.png';

export interface SettingsHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  onCheckUpdates?: () => void;
}

// Build identity stamp (injected by vite.config.ts from git HEAD).
declare const __BARANG_COMMIT__: string | undefined;

const FONT_SIZES = [12, 13, 14, 15, 16];

export function openSettings(hooks: SettingsHooks) {
  const overlay = el('div', { class: 'settings-overlay' });
  const dialog = el('div', { class: 'settings-modal', role: 'dialog', 'aria-label': 'Settings' });
  const head = el('div', { class: 'settings-head' });
  head.append(el('span', { class: 'settings-title' }, 'Settings'));
  const btnClose = el('button', { class: 'icon-btn', title: 'Close (Esc)' }) as HTMLButtonElement;
  btnClose.append(iconEl('x', 15));
  head.append(btnClose);
  dialog.append(head);

  const body = el('div', { class: 'settings-body' });

  // Section registry (single source of truth for the nav rail). Every
  // section() call below must use one of these titles.
  const SECTIONS = ['Model', 'Agent', 'Chat', 'Editor', 'Terminal', 'Sessions', 'Notifications', 'Startup', 'Layout', 'About'];
  const secSlug = (t: string) => 'sec-' + t.toLowerCase();
  const section = (title: string) => body.append(el('p', { class: 'settings-label', id: secSlug(title) }, title));
  // Toggle switch row (VSCode-style). The real checkbox stays in the DOM
  // (keyboard + state code untouched) — only its visuals become a switch.
  const checkRow = (label: string) => {
    const row = el('label', { class: 'settings-check' });
    const text = el('span', { class: 'settings-check-label' }, label);
    const box = el('input', { type: 'checkbox', class: 'switch-input' }) as HTMLInputElement;
    const track = el('span', { class: 'switch-track' });
    track.append(el('span', { class: 'switch-thumb' }));
    row.append(text, box, track);
    body.append(row);
    return box;
  };

  // --- Model ---
  section('Model');
  const freeBox = checkRow('Free models only');
  const modelSel = el('select', { class: 'model-sel settings-select', title: 'Model' }) as HTMLSelectElement;
  body.append(modelSel);
  body.append(el('p', { class: 'settings-note' }, 'Models come from your opencode login. “Auto” lets opencode choose per task.'));

  // --- Agent ---
  section('Agent');
  const agentSel = el('select', { class: 'agent-sel settings-select', title: 'Agent' }) as HTMLSelectElement;
  body.append(agentSel);
  const usageBox = checkRow('Show session cost meter');
  const fullAutoBox = checkRow('Full permissions (auto-approve agent requests)');
  body.append(el('p', { class: 'settings-note' }, 'Like opencode --auto: permission prompts are approved and remembered automatically. Explicit deny rules still apply.'));

  // --- Chat ---

  // --- Chat ---
  section('Chat');
  const reasonBox = checkRow('Show agent reasoning steps');
  const activityBox = checkRow('Show agent activity (steps, tool calls)');

  // --- Editor ---
  section('Editor');
  const fontRow = el('div', { class: 'settings-row' });
  fontRow.append(el('span', { class: 'settings-row-label' }, 'Font size'));
  const fontSel = el('select', { class: 'settings-inline-sel', title: 'Editor font size' }) as HTMLSelectElement;
  for (const n of FONT_SIZES) fontSel.append(el('option', { value: String(n) }, `${n}px`) as HTMLOptionElement);
  fontRow.append(fontSel);
  body.append(fontRow);
  const minimapBox = checkRow('Minimap');
  const wrapBox = checkRow('Word wrap');

  // --- Sessions ---
  section('Sessions');
  const confirmBox = checkRow('Ask before deleting a session');

  // --- Notifications (Windows toast + taskbar badge + sound) ---
  section('Notifications');
  const notifEnabledBox = checkRow('Enable notifications');
  const notifDoneBox = checkRow('When a run finishes');
  const notifApprovalBox = checkRow('When approval is needed');
  const notifErrorBox = checkRow('When a run errors');
  const notifNativeBox = checkRow('Windows toast when Barang is in the background');
  const notifTaskbarBox = checkRow('Taskbar badge + flashing when in the background');
  const notifToastBox = checkRow('In-app toast when Barang is focused');
  const notifSoundBox = checkRow('Play a sound');
  const soundRow = el('div', { class: 'settings-row' });
  soundRow.append(el('span', { class: 'settings-row-label' }, 'Sound'));
  const soundSel = el('select', { class: 'settings-inline-sel', title: 'Notification sound' }) as HTMLSelectElement;
  for (const s of BUILTIN_SOUNDS) soundSel.append(el('option', { value: s.id }, s.label) as HTMLOptionElement);
  soundSel.append(el('option', { value: 'custom' }, 'Custom… (pick a file)') as HTMLOptionElement);
  soundRow.append(soundSel);
  body.append(soundRow);
  const customRow = el('div', { class: 'settings-row' });
  const customName = el('span', { class: 'settings-row-label' }, 'No custom sound');
  const btnBrowseSound = el('button', { class: 'btn btn-sm' }, 'Browse…') as HTMLButtonElement;
  customRow.append(customName, btnBrowseSound);
  body.append(customRow);
  const volRow = el('div', { class: 'settings-row' });
  volRow.append(el('span', { class: 'settings-row-label' }, 'Volume'));
  const volWrap = el('span', { class: 'settings-vol-wrap' });
  const volInput = el('input', { class: 'settings-range', type: 'range', min: '0', max: '100', step: '1', title: 'Notification volume' }) as HTMLInputElement;
  const volLabel = el('span', { class: 'settings-vol-label' }, '80%');
  volWrap.append(volInput, volLabel);
  volRow.append(volWrap);
  body.append(volRow);
  const testRow = el('div', { class: 'settings-row' });
  testRow.append(el('span', { class: 'settings-row-label' }, 'Preview'));
  const btnTestSound = el('button', { class: 'btn btn-sm' }, 'Play sound') as HTMLButtonElement;
  testRow.append(btnTestSound);
  body.append(testRow);
  body.append(el('p', { class: 'settings-note' }, 'Sounds are original synth tones shipped with Barang. Custom files (MP3, WAV, OGG) are copied into Barang storage.'));

  // --- Terminal ---
  section('Terminal');
  const shellRow = el('div', { class: 'settings-row' });
  shellRow.append(el('span', { class: 'settings-row-label' }, 'Shell'));
  const shellInput = el('input', { class: 'settings-text', placeholder: 'Auto (PowerShell / $SHELL)', title: 'Shell executable path — empty for auto' }) as HTMLInputElement;
  shellRow.append(shellInput);
  body.append(shellRow);
  const termFontRow = el('div', { class: 'settings-row' });
  termFontRow.append(el('span', { class: 'settings-row-label' }, 'Font size'));
  const termFontSel = el('select', { class: 'settings-inline-sel', title: 'Terminal font size' }) as HTMLSelectElement;
  for (const n of [11, 12, 13, 14, 15, 16]) termFontSel.append(el('option', { value: String(n) }, `${n}px`) as HTMLOptionElement);
  termFontRow.append(termFontSel);
  body.append(termFontRow);
  const termScrollRow = el('div', { class: 'settings-row' });
  termScrollRow.append(el('span', { class: 'settings-row-label' }, 'Scrollback'));
  const termScrollSel = el('select', { class: 'settings-inline-sel', title: 'Terminal scrollback lines' }) as HTMLSelectElement;
  for (const n of [1000, 5000, 10000]) termScrollSel.append(el('option', { value: String(n) }, `${n} lines`) as HTMLOptionElement);
  termScrollRow.append(termScrollSel);
  body.append(termScrollRow);
  const termBlinkBox = checkRow('Cursor blink');

  // --- Startup ---
  section('Startup');
  const restoreBox = checkRow('Reopen last project on startup');
  void appState()
    .then((s) => {
      restoreBox.checked = s.restore === true;
    })
    .catch(() => {
      restoreBox.toggleAttribute('disabled', true);
    });

  // --- Layout ---
  section('Layout');
  const resetRow = el('div', { class: 'settings-row' });
  resetRow.append(el('span', { class: 'settings-row-label' }, 'Panel sizes'));
  const btnResetLayout = el('button', { class: 'btn btn-sm' }, 'Reset to defaults');
  resetRow.append(btnResetLayout);
  body.append(resetRow);

  // Nav rail (VSCode-style): click scrolls, scroll-spy highlights.
  const content = el('div', { class: 'settings-content' });
  const nav = el('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });
  const navBtns = new Map<string, HTMLButtonElement>();
  for (const t of SECTIONS) {
    const b = el('button', { class: 'settings-nav-item' }, t) as HTMLButtonElement;
    b.onclick = () => {
      setActiveNav(t);
      document.getElementById(secSlug(t))?.scrollIntoView({ block: 'start' });
    };
    nav.append(b);
    navBtns.set(t, b);
  }
  const setActiveNav = (t: string) => {
    for (const [name, b] of navBtns) b.classList.toggle('active', name === t);
  };
  let spyQueued = false;
  body.addEventListener('scroll', () => {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(() => {
      spyQueued = false;
      const top = body.getBoundingClientRect().top;
      let cur = SECTIONS[0];
      for (const t of SECTIONS) {
        const s = document.getElementById(secSlug(t));
        if (s && s.getBoundingClientRect().top - top <= 28) cur = t;
      }
      setActiveNav(cur);
    });
  });
  setActiveNav(SECTIONS[0]);
  content.append(nav, body);
  dialog.append(content);
  overlay.append(dialog);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  btnClose.onclick = close;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  /** Push a settings change through: persist, apply live, repaint UI. */
  const commit = (mut: (s: ReturnType<typeof readSettings>) => void) => {
    const s = readSettings();
    mut(s);
    writeSettings(s);
    agentStore.set({}); // notify subscribers (chat/status repaint)
    paint();
  };

  const paintModels = () => {
    const s = agentStore.get();
    const list = listSelectableModels();
    modelSel.innerHTML = '';
    modelSel.append(el('option', { value: '' }, 'Auto (opencode default)') as HTMLOptionElement);
    let lastProv = '';
    for (const m of list) {
      if (m.providerID !== lastProv) {
        const g = document.createElement('optgroup');
        g.label = m.providerID;
        modelSel.append(g);
        lastProv = m.providerID;
      }
      (modelSel.lastElementChild as HTMLOptGroupElement)?.append(
        el('option', { value: m.label }, m.modelID) as HTMLOptionElement,
      );
    }
    modelSel.value = s.model ? `${s.model.providerID}/${s.model.modelID}` : '';
  };

  const paintAgents = () => {
    const s = agentStore.get();
    agentSel.innerHTML = '';
    for (const a of s.agents) {
      agentSel.append(el('option', { value: a.name }, `${a.name}${a.mode ? ` (${a.mode})` : ''}`) as HTMLOptionElement);
    }
    agentSel.value = s.agent;
  };

  const paint = () => {
    // Normalize: a paid model can never be active with freeOnly on
    // (e.g. provider list changed since it was picked).
    const s0 = agentStore.get();
    const st0 = readSettings();
    if (st0.freeOnly && s0.model && !isFreeModel(s0.model.providerID, s0.model.modelID)) {
      const d = pickDefaultModel(s0.providerModels.filter((m) => isFreeModel(m.providerID, m.modelID)));
      st0.model = d;
      writeSettings(st0);
      agentStore.set({ model: d });
      return; // subscribe re-fires paint with consistent state
    }
    freeBox.checked = st0.freeOnly;
    usageBox.checked = st0.showUsage;
    fullAutoBox.checked = st0.agentFullAuto;
    reasonBox.checked = st0.showReasoning;
    activityBox.checked = st0.showActivity;
    minimapBox.checked = st0.minimap;
    wrapBox.checked = st0.wordWrap;
    confirmBox.checked = st0.confirmDelete;
    fontSel.value = String(st0.fontSize);
    notifEnabledBox.checked = st0.notifEnabled;
    notifDoneBox.checked = st0.notifOnDone;
    notifApprovalBox.checked = st0.notifOnApproval;
    notifErrorBox.checked = st0.notifOnError;
    notifNativeBox.checked = st0.notifNative;
    notifTaskbarBox.checked = st0.notifTaskbar;
    notifToastBox.checked = st0.notifToastFocused;
    notifSoundBox.checked = st0.notifSound;
    soundSel.value = st0.notifSoundName === 'custom' || BUILTIN_SOUNDS.some((s) => s.id === st0.notifSoundName) ? st0.notifSoundName : 'chime';
    customName.textContent = st0.notifCustomName || 'No custom sound';
    volInput.value = String(st0.notifVolume);
    volLabel.textContent = `${st0.notifVolume}%`;
    shellInput.value = st0.termShell;
    termFontSel.value = String(st0.termFont);
    termScrollSel.value = String(st0.termScrollback);
    termBlinkBox.checked = st0.termBlink;
    paintModels();
    paintAgents();
  };

  freeBox.onchange = () => {
    commit((settings) => {
      settings.freeOnly = freeBox.checked;
      // Enabling the filter with a paid model active would leave the UI and
      // the agent disagreeing — switch to the free default instead.
      const cur = agentStore.get().model;
      if (settings.freeOnly && cur && !isFreeModel(cur.providerID, cur.modelID)) {
        const d = pickDefaultModel(agentStore.get().providerModels.filter((m) => isFreeModel(m.providerID, m.modelID)));
        settings.model = d;
        agentStore.set({ model: d });
        hooks.toast(d ? `Switched to ${d.providerID}/${d.modelID} (free models only).` : 'Switched to Auto (free models only).', 'info');
      }
    });
  };
  modelSel.onchange = () => {
    applyModelSelection(modelSel.value);
  };
  agentSel.onchange = () => {
    commit((settings) => {
      settings.agent = agentSel.value;
      setAgent(agentSel.value);
    });
  };
  usageBox.onchange = () => {
    commit((s) => { s.showUsage = usageBox.checked; });
    agentStore.set({}); // repaint statusbar meter
  };
  fullAutoBox.onchange = () => {
    commit((s) => { s.agentFullAuto = fullAutoBox.checked; });
    hooks.toast(fullAutoBox.checked ? 'Full permissions on — agent requests are auto-approved.' : 'Full permissions off — the agent will ask again.', 'info');
  };
  reasonBox.onchange = () => commit((s) => { s.showReasoning = reasonBox.checked; });
  activityBox.onchange = () => commit((s) => { s.showActivity = activityBox.checked; });
  minimapBox.onchange = () => {
    commit((s) => { s.minimap = minimapBox.checked; });
    applyEditorPrefs();
  };
  wrapBox.onchange = () => {
    commit((s) => { s.wordWrap = wrapBox.checked; });
    applyEditorPrefs();
  };
  fontSel.onchange = () => {
    commit((s) => { s.fontSize = parseInt(fontSel.value, 10) || 13; });
    applyEditorPrefs();
  };
  confirmBox.onchange = () => commit((s) => { s.confirmDelete = confirmBox.checked; });
  notifEnabledBox.onchange = () => commit((s) => { s.notifEnabled = notifEnabledBox.checked; });
  notifDoneBox.onchange = () => commit((s) => { s.notifOnDone = notifDoneBox.checked; });
  notifApprovalBox.onchange = () => commit((s) => { s.notifOnApproval = notifApprovalBox.checked; });
  notifErrorBox.onchange = () => commit((s) => { s.notifOnError = notifErrorBox.checked; });
  notifNativeBox.onchange = () => commit((s) => { s.notifNative = notifNativeBox.checked; });
  notifTaskbarBox.onchange = () => commit((s) => { s.notifTaskbar = notifTaskbarBox.checked; });
  notifToastBox.onchange = () => commit((s) => { s.notifToastFocused = notifToastBox.checked; });
  notifSoundBox.onchange = () => commit((s) => { s.notifSound = notifSoundBox.checked; });
  soundSel.onchange = () => {
    commit((s) => { s.notifSoundName = soundSel.value; });
    if (soundSel.value === 'custom' && !readSettings().notifCustomPath) void browseSound();
  };
  volInput.onchange = () => {
    commit((s) => { s.notifVolume = parseInt(volInput.value, 10) || 0; });
  };
  btnTestSound.onclick = () => {
    const s = readSettings();
    const url = resolveSoundUrl(s.notifSoundName, s.notifCustomPath);
    if (!url) {
      hooks.toast('Pick a custom sound first.', 'info');
      return;
    }
    void playNotificationSound(url, s.notifVolume / 100).then((ok) => {
      if (!ok) hooks.toast('Could not play that sound (format or autoplay blocked — click anywhere and retry).', 'error');
    });
  };
  async function browseSound() {
    try {
      const r = await barang().app.pickSound();
      commit((s) => {
        s.notifSoundName = 'custom';
        s.notifCustomName = r.name;
        s.notifCustomPath = r.fileUrl;
      });
      paint();
      hooks.toast(`Custom sound: ${r.name}`, 'info');
    } catch (e) {
      if (!/cancelled/i.test((e as Error).message)) hooks.toast(`Sound picker failed: ${(e as Error).message}`, 'error');
    }
  }
  btnBrowseSound.onclick = () => void browseSound();
  shellInput.onchange = () => {
    commit((s) => { s.termShell = shellInput.value.trim().slice(0, 500); });
    hooks.toast(shellInput.value.trim() ? 'Shell saved — applies to new terminals.' : 'Shell reset to auto.', 'info');
  };
  termFontSel.onchange = () => {
    commit((s) => { s.termFont = parseInt(termFontSel.value, 10) || 12; });
    applyTerminalPrefs();
  };
  termScrollSel.onchange = () => {
    commit((s) => { s.termScrollback = parseInt(termScrollSel.value, 10) || 1000; });
    applyTerminalPrefs();
  };
  termBlinkBox.onchange = () => {
    commit((s) => { s.termBlink = termBlinkBox.checked; });
    applyTerminalPrefs();
  };
  restoreBox.onchange = () => {
    void barang()
      .app.setRestore(restoreBox.checked)
      .then((r) => {
        restoreBox.checked = r.restore;
        hooks.toast(r.restore ? 'Will reopen the last project on startup.' : 'Will start with no project open.', 'info');
      })
      .catch((e) => {
        restoreBox.checked = !restoreBox.checked;
        hooks.toast((e as Error).message, 'error');
      });
  };
  btnResetLayout.onclick = () => {
    try {
      localStorage.removeItem('barang:layout-v1');
    } catch { /* noop */ }
    document.documentElement.style.setProperty('--side-w', '264px');
    document.documentElement.style.setProperty('--agent-w', '372px');
    window.dispatchEvent(new Event('resize'));
    hooks.toast('Panel sizes reset to defaults.', 'info');
  };

  // --- About ---
  section('About');
  const about = el('div', { class: 'about-box' });
  const aboutHead = el('div', { class: 'about-head' });
  const aboutLogo = el('img', { class: 'brand-logo', src: logoUrl, alt: 'Barang logo', width: '26', height: '26' }) as HTMLImageElement;
  aboutHead.append(aboutLogo, el('span', { class: 'about-name' }, 'Barang'));
  const aboutVer = el('span', { class: 'about-ver' }, '…');
  aboutHead.append(aboutVer);
  about.append(aboutHead);
  about.append(el('p', { class: 'about-text' }, 'Built by slickmagic19.'));
  const updateRow = el('div', { class: 'about-update-row' });
  const btnCheckUpdates = el('button', { class: 'btn btn-sm' }, 'Check for updates') as HTMLButtonElement;
  btnCheckUpdates.onclick = () => hooks.onCheckUpdates?.();
  updateRow.append(btnCheckUpdates);
  about.append(updateRow);
  const credit = el('p', { class: 'about-text' });
  credit.append('Agent engine by ');
  const link = el('a', { href: 'https://opencode.ai', target: '_blank', rel: 'noreferrer' }, 'opencode');
  credit.append(link, '.');
  about.append(credit);
  body.append(about);
  void appState()
    .then((s) => {
      const commit = typeof __BARANG_COMMIT__ !== 'undefined' ? __BARANG_COMMIT__ : 'dev';
      aboutVer.textContent = `v${s.versions.app} · ${commit} · opencode ${s.opencode.version ?? s.opencode.cli ?? ''}`.trim();
    })
    .catch(() => {
      aboutVer.textContent = '';
    });

  agentStore.subscribe(paint);
  void loadMeta().then(paint).catch((e) => hooks.toast(`opencode metadata: ${e.message}`, 'error'));
  paint();
}
