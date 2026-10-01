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
import logoUrl from '../assets/barang-logo.png';

export interface SettingsHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
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

  const section = (title: string) => body.append(el('p', { class: 'settings-label' }, title));
  const checkRow = (label: string) => {
    const row = el('label', { class: 'settings-check' });
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    row.append(box, el('span', {}, label));
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

  dialog.append(body);
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
    reasonBox.checked = st0.showReasoning;
    activityBox.checked = st0.showActivity;
    minimapBox.checked = st0.minimap;
    wrapBox.checked = st0.wordWrap;
    confirmBox.checked = st0.confirmDelete;
    fontSel.value = String(st0.fontSize);
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
