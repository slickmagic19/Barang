// Settings modal (topbar gear): everything adjustable in Barang.
// Sections: Model (free Kilo Code models filter), Agent, Chat
// (reasoning visibility), Editor (font, minimap), Sessions (delete confirm),
// Layout (panel reset). Persisted to localStorage, applied immediately.
import {
  agentStore, loadMeta, readSettings, writeSettings, isFreeKiloModel, pickDefaultModel,
  setAgent, listSelectableModels, applyModelSelection, aggregateUsage, loadSkills,
  type SessionInfo,
} from '../lib/agent';
import { parseSkillMarkdown, skillsByScope } from '../lib/skills';
import {
  parseMemoryMarkdown, serializeMemory, renderMemoryIndex, upsertIndexLine, removeIndexLine,
  validateMemoryInput,
} from '../lib/memory';
import {
  parseMcpFile, toServerList, buildFileText, validateServer, parseKvLines,
  toLiveConfig, wordpressQuickFill, mergeStatuses,
  type McpScope, type McpServerConfig, type McpLive, type McpRowStatus,
} from '../lib/mcp';
import {
  validateProviderEntry, parseModelIds, setProviderEntry, removeProviderEntry, listProviderEntries,
  migrateLegacyProviders,
  type CustomProviderEntry, type ProviderListItem,
} from '../lib/providers';
import { parseJsonc, timeAgo } from '../lib/util';
import { confirmDialog } from './dialog';
import { appState, oc } from '../lib/api';
import { barang } from '../lib/transport';
import { el } from '../lib/util';
import { iconEl } from './icons';
import { applyEditorPrefs } from './editor';
import { applyTerminalPrefs } from './terminal';
import { BUILTIN_SOUNDS, resolveKindSound, playNotificationSound } from '../lib/notify';
import logoUrl from '../assets/barang-logo.png';

export interface SettingsHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  onCheckUpdates?: () => void;
}

// Build identity stamp (injected by vite.config.ts from git HEAD).
declare const __BARANG_COMMIT__: string | undefined;

const FONT_SIZES = [12, 13, 14, 15, 16];

export function openSettings(hooks: SettingsHooks) {
  // Single instance: a second modal would duplicate section IDs and break
  // tab ranges (global lookups hit the first modal's labels).
  if (document.querySelector('.settings-overlay')) return;
  // Re-fetch hooks fired when a section's page becomes visible (Usage refreshes
  // live data each time it's opened, so a cold server / new sessions show).
  const onShow = new Map<string, () => void>();
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
  const SECTIONS = ['Account', 'Usage', 'Model', 'Agent', 'Skills', 'Repo map', 'Memory', 'MCP', 'Providers', 'Chat', 'Editor', 'Terminal', 'Sessions', 'Notifications', 'Startup', 'Layout', 'About'];
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

  // --- Account (KiloCode sign-in / sign-up / sign-out) ---
  // KiloCode's free models are rate-limited to anonymous users (HTTP 429).
  // Signing in lifts that limit. Two paths:
  //   - Browser sign-in (OAuth device flow): we run `kilo auth login`, show the
  //     device-auth URL + code, and the CLI stores the credential.
  //   - API key: paste a key from the profile; Barang stores + injects it.
  // Sign-out clears BOTH Barang's key and the CLI credential.
  section('Account');
  const acctBox = el('div', { class: 'account-box' });
  body.append(acctBox);
  body.append(el('p', { class: 'settings-note' },
    'Sign in to KiloCode to raise the anonymous rate limit (the 429 errors) and unlock your models. ' +
    'Use browser sign-in, paste a Kilo API key, or create an account.'));

  interface AcctStatus {
    loggedIn: boolean;
    name: string;
    email: string;
    team: string;
    balance: number | null;
    source?: string;
    hasKey?: boolean;
  }
  const acctState: {
    status: AcctStatus | null; loading: boolean; error: string; busy: boolean;
    device: { url: string; code: string; token: string } | null;
    showKey: boolean;
  } = {
    status: null, loading: true, error: '', busy: false, device: null, showKey: false,
  };

  const acctPaint = () => {
    acctBox.innerHTML = '';
    if (acctState.loading) {
      acctBox.append(el('div', { class: 'scm-none' }, 'Checking sign-in…'));
      return;
    }
    if (acctState.error) {
      acctBox.append(el('div', { class: 'chat-err' }, acctState.error));
    }
    const s = acctState.status;
    if (s?.loggedIn) {
      // Signed-in card: avatar + identity + a Sign out button.
      const card = el('div', { class: 'account-card' });
      const avatar = el('div', { class: 'account-avatar' }, (s.name || '?').slice(0, 1).toUpperCase());
      const info = el('div', { class: 'account-info' });
      info.append(el('div', { class: 'account-name' }, s.name || 'Signed in'));
      if (s.email) info.append(el('div', { class: 'account-sub' }, s.email));
      const meta: string[] = [];
      if (s.team) meta.push(s.team);
      if (typeof s.balance === 'number') meta.push(`Balance: $${s.balance.toFixed(2)}`);
      meta.push(s.hasKey || s.source === 'barang-key' ? 'Signed in via API key' : 'Signed in via browser');
      info.append(el('div', { class: 'account-sub' }, meta.join(' · ')));
      card.append(avatar, info);
      const btnOut = el('button', { class: 'btn btn-sm', title: 'Sign out' }, 'Sign out') as HTMLButtonElement;
      btnOut.disabled = acctState.busy;
      btnOut.onclick = () => { void acctLogout(); };
      card.append(btnOut);
      acctBox.append(card);
      return;
    }

    // Signed out. If a device flow is in progress, show its prompt + cancel.
    if (acctState.device) {
      const d = acctState.device;
      const panel = el('div', { class: 'account-device' });
      panel.append(el('div', { class: 'account-device-title' }, 'Sign in to KiloCode'));
      panel.append(el('div', { class: 'account-sub' },
        'Open the link below, then enter this code to authorize Barang:'));
      if (d.code) {
        const codeRow = el('div', { class: 'account-code-row' });
        codeRow.append(el('code', { class: 'account-code' }, d.code));
        const copyBtn = el('button', { class: 'btn btn-sm', title: 'Copy code' }, 'Copy') as HTMLButtonElement;
        copyBtn.onclick = () => { void barang().clip.write(d.code); hooks.toast('Code copied.', 'info'); };
        codeRow.append(copyBtn);
        panel.append(codeRow);
      }
      const openBtn = el('button', { class: 'btn btn-primary btn-sm', title: 'Open in browser' }, 'Open sign-in page') as HTMLButtonElement;
      openBtn.onclick = () => { void barang().app.openExternal(d.url); };
      panel.append(openBtn);
      const cancelBtn = el('button', { class: 'btn btn-sm', title: 'Cancel' }, 'Cancel') as HTMLButtonElement;
      cancelBtn.onclick = () => { acctCancelDevice(); };
      panel.append(cancelBtn);
      panel.append(el('div', { class: 'account-busy' }, 'Waiting for authorization in your browser…'));
      acctBox.append(panel);
      return;
    }

    // Signed-out form: primary "Sign in" (browser) + "Create account", plus an
    // expandable API-key option for users who already have a key.
    const form = el('div', { class: 'account-form' });
    const primary = el('div', { class: 'account-primary' });
    const btnBrowser = el('button', { class: 'btn btn-primary', title: 'Sign in with your browser' },
      'Sign in') as HTMLButtonElement;
    btnBrowser.disabled = acctState.busy;
    btnBrowser.onclick = () => { void acctLoginBrowser(); };
    const btnSignup = el('button', { class: 'btn', title: 'Create a KiloCode account' }, 'Create account') as HTMLButtonElement;
    btnSignup.onclick = () => { void barang().auth.signup(); };
    primary.append(btnBrowser, btnSignup);
    form.append(primary);

    // API-key fallback (collapsible).
    const keyToggle = el('button', { class: 'link-btn', title: 'Use an API key instead' },
      acctState.showKey ? 'Hide API key option' : 'Have an API key? Sign in with a key') as HTMLButtonElement;
    keyToggle.onclick = () => { acctState.showKey = !acctState.showKey; acctPaint(); };
    form.append(keyToggle);
    if (acctState.showKey) {
      const input = el('input', {
        class: 'settings-text account-key-input', type: 'password', autocomplete: 'off',
        spellcheck: 'false', placeholder: 'Paste your Kilo API key', 'aria-label': 'Kilo API key',
      }) as HTMLInputElement;
      const row = el('div', { class: 'account-row' });
      const btnKey = el('button', { class: 'btn btn-primary btn-sm', title: 'Sign in with key' },
        acctState.busy ? 'Signing in…' : 'Sign in with key') as HTMLButtonElement;
      btnKey.disabled = acctState.busy;
      btnKey.onclick = () => { void acctLoginKey(input.value); };
      input.onkeydown = (e) => {
        if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void acctLoginKey(input.value); }
      };
      row.append(input, btnKey);
      form.append(row);
      const getKey = el('button', { class: 'link-btn', title: 'Open your profile' }, 'Get a key from your profile') as HTMLButtonElement;
      getKey.onclick = () => { void barang().app.openExternal('https://app.kilo.ai/profile'); };
      form.append(getKey);
    }
    if (acctState.busy) form.append(el('div', { class: 'account-busy' }, 'Contacting KiloCode…'));
    acctBox.append(form);
  };

  const acctLoad = async () => {
    acctState.loading = true;
    acctState.error = '';
    acctPaint();
    try {
      acctState.status = await barang().auth.status();
    } catch (e) {
      acctState.status = null;
      acctState.error = `Could not check sign-in: ${(e as Error).message}`;
    }
    acctState.loading = false;
    acctPaint();
  };

  // Browser (OAuth device) sign-in: run the flow, show the prompt, resolve on done.
  let acctProgressUnsub: (() => void) | null = null;
  const acctLoginBrowser = async () => {
    acctState.busy = true;
    acctState.error = '';
    acctState.device = null;
    acctPaint();
    acctProgressUnsub?.();
    acctProgressUnsub = barang().auth.onLoginProgress((ev) => {
      if (ev.kind === 'prompt') {
        acctState.device = { url: ev.url || '', code: ev.code || '', token: ev.token || '' };
        acctPaint();
      } else if (ev.kind === 'success') {
        acctState.device = null;
      } else if (ev.kind === 'error') {
        acctState.error = ev.message || 'Sign-in failed.';
        acctState.device = null;
        acctPaint();
      }
    });
    try {
      const res = await barang().auth.login({ timeoutMs: 180000 });
      acctProgressUnsub?.();
      acctProgressUnsub = null;
      acctState.device = null;
      if (res.loggedIn) {
        hooks.toast('Signed in to KiloCode.', 'info');
      } else if (res.cancelled) {
        acctState.error = '';
      } else if (res.error && res.error !== 'timeout') {
        acctState.error = res.error;
      } else if (res.error === 'timeout') {
        acctState.error = 'Sign-in timed out. Try again.';
      }
      await acctLoad();
      void loadMeta().then(() => { paintModels(); }).catch(() => {});
    } catch (e) {
      acctProgressUnsub?.();
      acctProgressUnsub = null;
      acctState.device = null;
      acctState.error = (e as Error).message;
    }
    acctState.busy = false;
    acctPaint();
  };

  // Cancel an in-flight device flow: clearing state + reloading status is enough
  // (the main process kills the CLI on resolve/timeout; status is unchanged).
  const acctCancelDevice = () => {
    acctProgressUnsub?.();
    acctProgressUnsub = null;
    acctState.device = null;
    acctState.busy = false;
    acctState.error = '';
    acctPaint();
  };

  // API-key sign-in.
  const acctLoginKey = async (rawKey: string) => {
    const key = String(rawKey || '').trim();
    if (!key) { acctState.error = 'Paste your Kilo API key first.'; acctPaint(); return; }
    acctState.busy = true;
    acctState.error = '';
    acctPaint();
    try {
      await barang().auth.loginKey(key);
      hooks.toast('Signed in to KiloCode.', 'info');
      await acctLoad();
      void loadMeta().then(() => { paintModels(); }).catch(() => {});
    } catch (e) {
      acctState.error = (e as Error).message;
    }
    acctState.busy = false;
    acctPaint();
  };

  const acctLogout = async () => {
    acctState.busy = true;
    acctState.error = '';
    acctPaint();
    try {
      await barang().auth.logout();
      hooks.toast('Signed out of KiloCode.', 'info');
      await acctLoad();
    } catch (e) {
      acctState.error = (e as Error).message;
    }
    acctState.busy = false;
    acctPaint();
  };
  acctPaint();
  void acctLoad();

  // --- Usage (account balance + aggregate session usage) ---
  // Two data sources: the signed-in account balance (auth:status / profile) and
  // the local session ledger (all sessions' cost + tokens, aggregated). Sessions
  // are fetched unscoped so usage spans every project, not just the open one.
  // Balance resolves fast and paints first; the usage ledger streams in after.
  section('Usage');
  const usagePanel = el('div', { class: 'usage-box' });
  body.append(usagePanel);

  const fmtNum = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0).toLocaleString('en-US');
  const fmtCost = (n: number) => `$${Math.max(0, Number.isFinite(n) ? n : 0).toFixed(2)}`;
  const fmtCompact = (n: number) => {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}K`;
    if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    return `${(v / 1_000_000_000).toFixed(1)}B`;
  };

  const usageState: {
    balanceLoading: boolean;
    usageLoading: boolean;
    error: string;
    balance: number | null;
    signedIn: boolean;
    totals: ReturnType<typeof aggregateUsage> | null;
  } = { balanceLoading: true, usageLoading: true, error: '', balance: null, signedIn: false, totals: null };

  const usagePaint = () => {
    usagePanel.innerHTML = '';

    // --- Hero: balance card (paints as soon as auth resolves) ---
    const hero = el('div', { class: 'usage-hero' });
    const balCard = el('div', { class: 'usage-balance' });
    balCard.append(el('div', { class: 'usage-balance-label' }, 'KiloCode balance'));
    if (usageState.balanceLoading) {
      balCard.append(el('div', { class: 'usage-skeleton-lg' }));
    } else if (usageState.signedIn) {
      balCard.append(el('div', { class: 'usage-balance-value' },
        usageState.balance === null ? '—' : fmtCost(usageState.balance)));
    } else {
      const signIn = el('div', { class: 'usage-balance-empty' });
      signIn.append(el('span', {}, 'Not signed in'));
      const link = el('button', { class: 'link-btn', title: 'Open Account settings' }, 'Sign in') as HTMLButtonElement;
      link.onclick = () => { showPage('Account'); };
      signIn.append(link);
      balCard.append(signIn);
    }
    hero.append(balCard);

    // Summary chip row (totals at a glance) — skeletons while loading.
    const chips = el('div', { class: 'usage-chips' });
    const chip = (label: string, value: string) => {
      const c = el('div', { class: 'usage-chip' });
      c.append(el('div', { class: 'usage-chip-value' }, value));
      c.append(el('div', { class: 'usage-chip-label' }, label));
      return c;
    };
    const skelChip = (label: string) => {
      const c = el('div', { class: 'usage-chip' });
      c.append(el('div', { class: 'usage-skeleton' }));
      c.append(el('div', { class: 'usage-chip-label' }, label));
      return c;
    };
    const t = usageState.totals;
    if (usageState.usageLoading && !t) {
      chips.append(skelChip('Total cost'), skelChip('Sessions'), skelChip('Tokens'));
    } else if (t && t.sessions) {
      chips.append(
        chip(fmtCost(t.cost), 'Total cost'),
        chip(fmtNum(t.sessions), 'Sessions'),
        chip(fmtCompact(t.tokens), 'Tokens'),
      );
    }
    if (chips.childElementCount) hero.append(chips);
    usagePanel.append(hero);

    if (usageState.error) {
      usagePanel.append(el('div', { class: 'chat-err' }, usageState.error));
    }

    // --- Detailed breakdown ---
    if (usageState.usageLoading && !t) {
      // Skeleton rows so the panel never looks empty while the ledger loads.
      const skel = el('div', { class: 'usage-skeleton-list' });
      for (let i = 0; i < 3; i++) skel.append(el('div', { class: 'usage-skeleton-row' }));
      usagePanel.append(skel);
    } else if (t && t.sessions) {
      // Token detail grid.
      const grid = el('div', { class: 'usage-grid' });
      const cell = (label: string, value: string) => {
        const c = el('div', { class: 'usage-cell' });
        c.append(el('div', { class: 'usage-cell-value' }, value));
        c.append(el('div', { class: 'usage-cell-label' }, label));
        return c;
      };
      grid.append(
        cell(fmtCompact(t.input), 'Input tokens'),
        cell(fmtCompact(t.output), 'Output tokens'),
        cell(fmtCompact(t.reasoning), 'Reasoning'),
        cell(fmtCompact(t.cacheRead), 'Cache read'),
        cell(fmtCompact(t.cacheWrite), 'Cache write'),
        cell(fmtNum(t.sessions), 'Sessions'),
      );
      usagePanel.append(grid);

      // Per-model breakdown with proportional bars.
      if (t.byModel.length) {
        const group = el('div', { class: 'usage-group' });
        const head = el('div', { class: 'usage-group-head' });
        head.append(el('span', { class: 'usage-group-title' }, 'By model'));
        head.append(el('span', { class: 'usage-group-hint' }, `${t.byModel.length} model${t.byModel.length === 1 ? '' : 's'}`));
        group.append(head);
        const maxCost = Math.max(0.0001, ...t.byModel.map((m) => m.cost));
        for (const m of t.byModel.slice(0, 12)) {
          const row = el('div', { class: 'usage-model-row' });
          const top = el('div', { class: 'usage-model-top' });
          top.append(el('span', { class: 'usage-model-name', title: m.model }, m.model));
          top.append(el('span', { class: 'usage-model-cost' }, fmtCost(m.cost)));
          row.append(top);
          const bar = el('div', { class: 'usage-bar' });
          const fill = el('div', { class: 'usage-bar-fill' });
          // Cost bar when there's a cost; otherwise scale by tokens.
          const frac = m.cost > 0 ? (m.cost / maxCost) : (m.tokens / Math.max(1, t.tokens));
          fill.style.width = `${Math.max(3, Math.round(Math.min(1, frac) * 100))}%`;
          if (m.cost <= 0) fill.classList.add('is-free');
          bar.append(fill);
          row.append(bar);
          const meta = el('div', { class: 'usage-model-meta' },
            `${m.sessions} session${m.sessions === 1 ? '' : 's'} · ${fmtCompact(m.tokens)} tokens`);
          row.append(meta);
          group.append(row);
        }
        usagePanel.append(group);
      }
    } else {
      // Signed in but no sessions yet.
      usagePanel.append(el('div', { class: 'usage-empty' },
        'No sessions yet — usage appears here as you work.'));
    }

    // --- Footer note + actions (always present) ---
    const foot = el('div', { class: 'usage-foot' });
    foot.append(el('p', { class: 'settings-note' },
      'Totals span all sessions on this machine. Free models report $0.00; paid usage is billed to your KiloCode balance.'));
    const actions = el('div', { class: 'usage-actions' });
    const refresh = el('button', { class: 'btn btn-sm', title: 'Refresh usage' }, 'Refresh') as HTMLButtonElement;
    refresh.disabled = usageState.usageLoading;
    refresh.onclick = () => { void usageLoad(); };
    const dash = el('button', { class: 'btn btn-sm', title: 'Open Kilo dashboard' }, 'Open dashboard') as HTMLButtonElement;
    dash.onclick = () => { void barang().app.openExternal('https://app.kilo.ai'); };
    actions.append(refresh, dash);
    foot.append(actions);
    usagePanel.append(foot);
  };

  const usageLoad = async () => {
    // Reset to loading, paint skeletons, then resolve each source independently
    // so the balance appears immediately instead of waiting on the slow ledger.
    usageState.balanceLoading = true;
    usageState.usageLoading = true;
    usageState.error = '';
    usagePaint();

    // Balance (fast — paints as soon as auth resolves).
    void (async () => {
      try {
        const st = await barang().auth.status();
        usageState.signedIn = !!st?.loggedIn;
        usageState.balance = typeof st?.balance === 'number' ? st.balance : null;
      } catch {
        usageState.signedIn = false;
        usageState.balance = null;
      }
      usageState.balanceLoading = false;
      usagePaint();
    })();

    // Usage ledger (slower on a cold server — streams in after).
    try {
      const list = await oc.get<SessionInfo[] | { value?: SessionInfo[] }>('/session', { timeoutMs: 12000 }).catch(() => []);
      const all = Array.isArray(list) ? list : (list.value ?? []);
      usageState.totals = aggregateUsage(all);
    } catch (e) {
      usageState.totals = null;
      usageState.error = `Could not load usage: ${(e as Error).message}`;
    }
    usageState.usageLoading = false;
    usagePaint();
  };
  usagePaint();
  // Refresh usage each time the Usage page is opened (cold server / new sessions).
  // (Not loaded eagerly — the agent server may still be booting at modal build.)
  onShow.set('Usage', () => { void usageLoad(); });

  // --- Model ---
  section('Model');
  const freeBox = checkRow('Free Kilo Code models only');
  const modelSel = el('select', { class: 'model-sel settings-select', title: 'Model' }) as HTMLSelectElement;
  body.append(modelSel);
  body.append(el('p', { class: 'settings-note' }, 'Models come from your Kilo Code login. “Auto” lets Kilo Code choose per task.'));
  const relayBox = checkRow('Kilo Code models via CLI Relay');
  body.append(el('p', { class: 'settings-note' }, 'Off by default — Kilo Code chats go through the normal serve path (fast, streams). Turn on only to route them through your local `kilo run` CLI.'));
  const relayAutoBox = checkRow('Relay auto-approve (anything not denied)');
  body.append(el('p', { class: 'settings-note' }, 'Relayed runs cannot pop approval cards, so non-denied permissions auto-pass. Explicit deny rules are always respected — prefer narrow patterns (rm -rf *, git push --force). Never deny bash/read outright on free models.'));

  // --- Agent ---
  section('Agent');
  const agentSel = el('select', { class: 'agent-sel settings-select', title: 'Agent' }) as HTMLSelectElement;
  body.append(agentSel);
  const usageBox = checkRow('Show session cost meter');
  const fullAutoBox = checkRow('Full permissions (auto-approve agent requests)');
  body.append(el('p', { class: 'settings-note' }, 'Like kilo run --auto: permission prompts are approved and remembered automatically. Explicit deny rules still apply.'));

  // --- MCP (Model Context Protocol servers for the agent) ---
  section('MCP');
  body.append(el('p', { class: 'settings-note' }, 'Extra tools for the agent: local programs or remote HTTP servers. Servers apply after the agent server restarts. Tokens are stored as plain text — {env:NAME} references work too.'));
  const mcpBox = el('div', { class: 'mcp-box' });
  body.append(mcpBox);

  interface McpScopeState {
    servers: McpServerConfig[];
    text: string;
    path: string;
    error?: string;
  }
  const mcpState: {
    managed: McpScopeState | null;
    project: McpScopeState | null;
    live: Record<string, McpLive>;
    loading: boolean;
  } = { managed: null, project: null, live: {}, loading: true };

  const mcpScopeTitle = (scope: McpScope) => scope === 'project' ? 'This project' : 'Global (all projects)';
  const mcpScopeHint = (scope: McpScope) => scope === 'project'
    ? 'Saved to opencode.json in the project root (checked into Git with the project).'
    : 'Saved to Barang\u2019s global file, merged over every other layer (your own config files are never touched).';

  async function loadScope(scope: McpScope): Promise<McpScopeState> {
    const res = await barang().mcpConfig('read', { scope });
    const text = String(res?.text ?? '');
    try {
      const { mcp } = parseMcpFile(text);
      return { servers: toServerList(mcp), text, path: String(res?.path ?? '') };
    } catch (e) {
      return { servers: [], text, path: String(res?.path ?? ''), error: (e as Error).message };
    }
  }

  async function refreshMcp() {
    mcpState.loading = true;
    paintMcp();
    try {
      const [managed, project] = await Promise.all([loadScope('managed'), loadScope('project')]);
      mcpState.managed = managed;
      mcpState.project = project;
    } catch (e) {
      hooks.toast(`MCP load failed: ${(e as Error).message}`, 'error');
    }
    try {
      const live = await barang().oc('/mcp');
      mcpState.live = (live && typeof live === 'object' ? live : {}) as Record<string, McpLive>;
    } catch {
      mcpState.live = {};
    }
    mcpState.loading = false;
    paintMcp();
  }

  async function saveScope(scope: McpScope, servers: McpServerConfig[]) {
    const st = scope === 'project' ? mcpState.project : mcpState.managed;
    const mcp: Record<string, unknown> = {};
    for (const s of servers) mcp[s.name] = toLiveConfig(s);
    const text = buildFileText(st?.text ?? '', mcp);
    const res = await barang().mcpConfig('write', { scope, text });
    await refreshMcp();
    hooks.toast(`MCP ${mcpScopeTitle(scope).toLowerCase()} saved (backup kept next to it) — restart the agent server to apply.`, 'info');
    return res;
  }

  async function connectNow(scope: McpScope, server: McpServerConfig) {
    try {
      await barang().oc('/mcp', { method: 'POST', body: { name: server.name, config: toLiveConfig(server) } });
      try {
        mcpState.live = (await barang().oc('/mcp')) as Record<string, McpLive>;
      } catch { /* status refresh is best-effort */ }
      paintMcp();
      const lv = mcpState.live[server.name];
      if (lv?.status === 'connected' || JSON.stringify(lv).includes('connected')) {
        hooks.toast(`${server.name}: connected.`, 'info');
      } else {
        hooks.toast(`${server.name}: ${lv?.error ?? 'not connected — see status'}.`, 'error');
      }
    } catch (e) {
      hooks.toast(`Connect failed: ${(e as Error).message}`, 'error');
    }
  }

  const STATUS_DOT: Record<McpRowStatus, string> = {
    connected: 'is-ok',
    failed: 'is-err',
    'needs-auth': 'is-run',
    disabled: '',
    'needs-restart': '',
    unknown: '',
  };

  function paintMcp() {
    mcpBox.innerHTML = '';
    if (mcpState.loading) {
      mcpBox.append(el('div', { class: 'scm-none' }, 'Loading MCP servers…'));
      return;
    }
    const bar = el('div', { class: 'mcp-bar' });
    const btnRefresh = el('button', { class: 'btn btn-sm' }, 'Refresh status') as HTMLButtonElement;
    btnRefresh.onclick = () => void refreshMcp().catch((e) => hooks.toast(e.message, 'error'));
    const btnRestart = el('button', { class: 'btn btn-sm' }, 'Restart agent server') as HTMLButtonElement;
    btnRestart.title = 'Applies saved MCP changes (stops running work)';
    btnRestart.onclick = () => {
      void (async () => {
        const ok = await confirmDialog({
          title: 'Restart the agent server?',
          message: 'Saved MCP changes apply on restart. Running work will stop.',
          confirmLabel: 'Restart',
          danger: true,
        });
        if (!ok) return;
        try {
          await barang().app.retryOpencode();
          hooks.toast('Agent server restarting…', 'info');
        } catch (e) {
          hooks.toast(`Restart failed: ${(e as Error).message}`, 'error');
        }
      })();
    };
    bar.append(btnRefresh, btnRestart);
    mcpBox.append(bar);

    (['project', 'managed'] as McpScope[]).forEach((scope) => {
      const st = scope === 'project' ? mcpState.project : mcpState.managed;
      const group = el('div', { class: 'mcp-group' });
      group.append(el('div', { class: 'mcp-group-title' }, mcpScopeTitle(scope)));
      group.append(el('p', { class: 'settings-note' }, mcpScopeHint(scope)));
      if (!st) {
        group.append(el('div', { class: 'scm-none' }, 'Could not load.'));
      } else if (st.error) {
        group.append(el('div', { class: 'chat-err' }, `Config unreadable: ${st.error}`));
      } else if (!st.servers.length) {
        group.append(el('div', { class: 'scm-none' }, 'No servers. Add one below.'));
      } else {
        const { rows } = mergeStatuses(st.servers, mcpState.live);
        for (const r of rows) {
          const row = el('div', { class: 'mcp-row' });
          const dot = el('span', { class: `tool-dot ${STATUS_DOT[r.effective]}`.trim() });
          const main = el('div', { class: 'mcp-main' });
          main.append(el('div', { class: 'mcp-name' }, r.server.name));
          const sub = r.server.type === 'remote'
            ? (r.server.url ?? '')
            : `local: ${(r.server.command ?? []).join(' ')}`;
          main.append(el('div', { class: 'mcp-sub' }, sub));
          if (r.note) main.append(el('div', { class: 'mcp-note' }, r.note));
          row.append(dot, main);
          const acts = el('div', { class: 'mcp-acts' });
          const bConn = el('button', { class: 'btn btn-sm', title: 'Connect now (no restart needed)' }, 'Connect') as HTMLButtonElement;
          bConn.onclick = () => void connectNow(scope, r.server);
          const bToggle = el('button', { class: 'btn btn-sm', title: r.server.enabled === false ? 'Enable' : 'Disable' }, r.server.enabled === false ? 'Enable' : 'Disable') as HTMLButtonElement;
          bToggle.onclick = () => {
            void (async () => {
              try {
                const next = (st.servers ?? []).map((x) => x.name === r.server.name
                  ? { ...x, enabled: x.enabled === false ? true : false }
                  : x);
                await saveScope(scope, next);
              } catch (e) {
                hooks.toast((e as Error).message, 'error');
              }
            })();
          };
          const bDel = el('button', { class: 'btn btn-sm', title: 'Remove' }, 'Remove') as HTMLButtonElement;
          bDel.onclick = () => {
            void (async () => {
              const ok = await confirmDialog({
                title: `Remove ${r.server.name}?`,
                message: 'The server entry is deleted from the config file (a backup is kept next to it).',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              try {
                await saveScope(scope, (st.servers ?? []).filter((x) => x.name !== r.server.name));
              } catch (e) {
                hooks.toast((e as Error).message, 'error');
              }
            })();
          };
          acts.append(bConn, bToggle, bDel);
          row.append(acts);
          group.append(row);
        }
      }
      mcpBox.append(group);
    });

    const foreign = Object.keys(mcpState.live).length;
    if (foreign > 0) {
      mcpBox.append(el('p', { class: 'settings-note' }, 'Status refresh also sees servers from your other config layers; only the two groups above are managed here.'));
    }

    // WordPress (Easy MCP AI) quick add.
    const wp = el('div', { class: 'mcp-wp' });
    wp.append(el('div', { class: 'mcp-group-title' }, 'WordPress quick add'));
    wp.append(el('p', { class: 'settings-note' }, 'Easy MCP AI plugin: paste your site URL and an API token (WordPress admin → Easy MCP AI → API Tokens). Uses Bearer-token mode over Streamable HTTP.'));
    const wpSite = el('input', { class: 'settings-text', placeholder: 'https://yoursite.com' }) as HTMLInputElement;
    const wpToken = el('input', { class: 'settings-text', placeholder: 'wpmcp_… (API token)', type: 'password' }) as HTMLInputElement;
    const wpScope = el('select', { class: 'settings-inline-sel', title: 'Where to save' }) as HTMLSelectElement;
    wpScope.append(el('option', { value: 'project' }, 'This project') as HTMLOptionElement);
    wpScope.append(el('option', { value: 'managed' }, 'Global') as HTMLOptionElement);
    const wpAdd = el('button', { class: 'btn btn-primary btn-sm' }, 'Add WordPress') as HTMLButtonElement;
    wpAdd.onclick = () => {
      void (async () => {
        const scope = (wpScope.value === 'managed' ? 'managed' : 'project') as McpScope;
        const srv = wordpressQuickFill(wpSite.value, wpToken.value);
        if (!srv.url) {
          hooks.toast('Enter the site URL.', 'error');
          return;
        }
        const errs = validateServer(srv);
        if (errs.length) {
          hooks.toast(errs.join(' '), 'error');
          return;
        }
        try {
          const st = scope === 'project' ? mcpState.project : mcpState.managed;
          const rest = (st?.servers ?? []).filter((x) => x.name !== srv.name);
          await saveScope(scope, [...rest, srv]);
          wpSite.value = '';
          wpToken.value = '';
          await connectNow(scope, srv);
        } catch (e) {
          hooks.toast((e as Error).message, 'error');
        }
      })();
    };
    wp.append(wpSite, wpToken, wpScope, wpAdd);
    mcpBox.append(wp);

    // Generic add form.
    const add = el('div', { class: 'mcp-add' });
    add.append(el('div', { class: 'mcp-group-title' }, 'Add server'));
    const fName = el('input', { class: 'settings-text', placeholder: 'Name (letters, numbers, dash)' }) as HTMLInputElement;
    const fType = el('select', { class: 'settings-inline-sel', title: 'Type' }) as HTMLSelectElement;
    fType.append(el('option', { value: 'remote' }, 'Remote (HTTP)') as HTMLOptionElement);
    fType.append(el('option', { value: 'local' }, 'Local (program)') as HTMLOptionElement);
    const fUrl = el('input', { class: 'settings-text', placeholder: 'https://…/mcp' }) as HTMLInputElement;
    const fCmd = el('input', { class: 'settings-text hidden', placeholder: 'npx -y some-mcp-server' }) as HTMLInputElement;
    const fToken = el('input', { class: 'settings-text', placeholder: 'Bearer token (optional — Bearer {env:NAME} also works)', type: 'password' }) as HTMLInputElement;
    const fOAuth = el('label', { class: 'settings-check' }) as HTMLLabelElement;
    const fOAuthBox = el('input', { type: 'checkbox', class: 'switch-input' }) as HTMLInputElement;
    const fOAuthTrack = el('span', { class: 'switch-track' });
    fOAuthTrack.append(el('span', { class: 'switch-thumb' }));
    fOAuth.append(fOAuthBox, el('span', { class: 'settings-check-label' }, 'OAuth (uncheck for token-only servers)'), fOAuthTrack);
    fOAuthBox.checked = true;
    const fHeaders = el('textarea', { class: 'settings-text mcp-area hidden', placeholder: 'Extra headers, one per line — Name: value' }) as HTMLTextAreaElement;
    const fEnv = el('textarea', { class: 'settings-text mcp-area hidden', placeholder: 'Env vars, one per line — KEY=value' }) as HTMLTextAreaElement;
    const fScope = el('select', { class: 'settings-inline-sel', title: 'Where to save' }) as HTMLSelectElement;
    fScope.append(el('option', { value: 'project' }, 'This project') as HTMLOptionElement);
    fScope.append(el('option', { value: 'managed' }, 'Global') as HTMLOptionElement);
    const paintType = () => {
      const local = fType.value === 'local';
      fUrl.classList.toggle('hidden', local);
      fToken.classList.toggle('hidden', local);
      fOAuth.classList.toggle('hidden', local);
      fHeaders.classList.toggle('hidden', local);
      fCmd.classList.toggle('hidden', !local);
      fEnv.classList.toggle('hidden', !local);
    };
    fType.onchange = paintType;
    paintType();
    const fSave = el('button', { class: 'btn btn-primary btn-sm' }, 'Save server') as HTMLButtonElement;
    fSave.onclick = () => {
      void (async () => {
        const scope = (fScope.value === 'managed' ? 'managed' : 'project') as McpScope;
        const local = fType.value === 'local';
        const hasToken = fToken.value.trim() !== '';
        const srv: McpServerConfig = local
          ? { name: fName.value.trim(), type: 'local', command: fCmd.value.split(/\s+/).filter(Boolean), environment: parseKvLines(fEnv.value, '='), enabled: true }
          : {
            name: fName.value.trim(), type: 'remote', url: fUrl.value.trim(),
            headers: { ...parseKvLines(fHeaders.value, ':'), ...(hasToken ? { Authorization: `Bearer ${fToken.value.trim()}` } : {}) },
            oauth: hasToken ? false : fOAuthBox.checked, enabled: true,
          };
        if (srv.headers && !Object.keys(srv.headers).length) delete srv.headers;
        if (srv.environment && !Object.keys(srv.environment).length) delete srv.environment;
        const errs = validateServer(srv);
        if (errs.length) {
          hooks.toast(errs.join(' '), 'error');
          return;
        }
        try {
          const st = scope === 'project' ? mcpState.project : mcpState.managed;
          const rest = (st?.servers ?? []).filter((x) => x.name !== srv.name);
          await saveScope(scope, [...rest, srv]);
          fName.value = '';
          fUrl.value = '';
          fCmd.value = '';
          fToken.value = '';
          fHeaders.value = '';
          fEnv.value = '';
          await connectNow(scope, srv);
        } catch (e) {
          hooks.toast((e as Error).message, 'error');
        }
      })();
    };
    add.append(fName, fType, fUrl, fCmd, fToken, fOAuth, fHeaders, fEnv, fScope, fSave);
    mcpBox.append(add);
    mcpBox.append(el('p', { class: 'settings-note' }, 'OAuth servers need one browser approval — easiest via the kilo TUI (`/connect`) once; Bearer tokens connect immediately.'));
  }

  void refreshMcp().catch(() => {});

  // --- Providers (extra OpenAI-compatible model endpoints) ---
  section('Providers');
  body.append(el('p', { class: 'settings-note' }, 'Extra model providers for the picker (OpenAI-compatible: OpenRouter, Groq, Ollama, …). Saved to Barang’s global file — your own configs are never touched. Providers added with `kilo auth login` are picked up when the agent server restarts — use Refresh below (or restart Barang).'));
  const provBox = el('div', { class: 'mcp-box' });
  body.append(provBox);

  interface ProvState {
    custom: ProviderListItem[] | null;
    path: string;
    error?: string;
    loading: boolean;
  }
  const provState: ProvState = { custom: null, path: '', loading: true };

  async function refreshProviders() {
    provState.loading = true;
    paintProviders();
    try {
      const res = await barang().mcpConfig('read', { scope: 'managed' });
      let text = String(res?.text ?? '');
      provState.path = String(res?.path ?? '');
      try {
        // Files from pre-fix builds used `providers`, which Kilo rejects —
        // repair them here so saved endpoints actually load.
        const fixed = migrateLegacyProviders(text);
        if (fixed !== null) {
          await barang().mcpConfig('write', { scope: 'managed', text: fixed });
          text = fixed;
        }
        if (text.trim()) parseJsonc(text);
        provState.custom = listProviderEntries(text);
        provState.error = undefined;
      } catch (e) {
        provState.custom = [];
        provState.error = (e as Error).message;
      }
    } catch (e) {
      provState.custom = [];
      provState.error = (e as Error).message;
    }
    provState.loading = false;
    paintProviders();
  }

  function paintProviders() {
    provBox.innerHTML = '';
    // Detected providers (every configured layer, read-only here).
    const seen = new Map<string, number>();
    for (const m of agentStore.get().providerModels) {
      seen.set(m.providerID, (seen.get(m.providerID) ?? 0) + 1);
    }
    const detected = el('div', { class: 'mcp-group' });
    const detHead = el('div', { class: 'mcp-group-head' });
    detHead.append(el('div', { class: 'mcp-group-title' }, 'Detected'));
    // One-click refresh: restarts the agent server (so it re-reads auth.json)
    // and reloads the provider catalog — picks up providers added via the CLI.
    const btnRefresh = el('button', { class: 'btn btn-sm', title: 'Restart the agent server to load providers added with kilo auth login' }, 'Refresh') as HTMLButtonElement;
    btnRefresh.onclick = () => {
      void (async () => {
        btnRefresh.disabled = true;
        try {
          await barang().app.retryOpencode();
          hooks.toast('Restarting the agent server to pick up new providers…', 'info');
          await loadMeta().catch(() => {});
          paintProviders();
          hooks.toast('Providers refreshed.', 'info');
        } catch (e) {
          hooks.toast(`Refresh failed: ${(e as Error).message}`, 'error');
        } finally {
          btnRefresh.disabled = false;
        }
      })();
    };
    detHead.append(btnRefresh);
    detected.append(detHead);
    if (!seen.size) {
      detected.append(el('div', { class: 'scm-none' }, 'No providers reported — is the agent server running?'));
    } else {
      for (const [id, n] of [...seen.entries()].sort()) {
        const row = el('div', { class: 'mcp-row' });
        const dot = el('span', { class: 'tool-dot is-ok' });
        const main = el('div', { class: 'mcp-main' });
        main.append(el('div', { class: 'mcp-name' }, id));
        main.append(el('div', { class: 'mcp-sub' }, `${n} model${n === 1 ? '' : 's'}`));
        row.append(dot, main);
        detected.append(row);
      }
    }
    provBox.append(detected);
    // Custom providers (Barang's global file) with remove buttons.
    const custom = el('div', { class: 'mcp-group' });
    custom.append(el('div', { class: 'mcp-group-title' }, 'Custom (global file)'));
    if (provState.loading) {
      custom.append(el('div', { class: 'scm-none' }, 'Loading…'));
    } else if (provState.error) {
      custom.append(el('div', { class: 'chat-err' }, `Config unreadable: ${provState.error}`));
    } else if (!provState.custom?.length) {
      custom.append(el('div', { class: 'scm-none' }, 'None yet. Add one below.'));
    } else {
      for (const p of provState.custom) {
        const row = el('div', { class: 'mcp-row' });
        const dot = el('span', { class: 'tool-dot' });
        const main = el('div', { class: 'mcp-main' });
        main.append(el('div', { class: 'mcp-name' }, p.id));
        main.append(el('div', { class: 'mcp-sub' }, `${p.baseURL || '(no endpoint)'} · ${p.models.length} model${p.models.length === 1 ? '' : 's'} · key: ${p.keyKind}`));
        row.append(dot, main);
        const acts = el('div', { class: 'mcp-acts' });
        const bDel = el('button', { class: 'btn btn-sm', title: 'Remove' }, 'Remove') as HTMLButtonElement;
        bDel.onclick = () => {
          void (async () => {
            const ok = await confirmDialog({
              title: `Remove provider ${p.id}?`,
              message: 'The entry is deleted from Barang’s global file (a backup is kept next to it). Models vanish after a server restart.',
              confirmLabel: 'Remove',
              danger: true,
            });
            if (!ok) return;
            try {
              const res = await barang().mcpConfig('read', { scope: 'managed' });
              const next = removeProviderEntry(String(res?.text ?? ''), p.id);
              await barang().mcpConfig('write', { scope: 'managed', text: next });
              await refreshProviders();
              hooks.toast(`Provider ${p.id} removed — restart the agent server to apply.`, 'info');
            } catch (e) {
              hooks.toast((e as Error).message, 'error');
            }
          })();
        };
        acts.append(bDel);
        row.append(acts);
        custom.append(row);
      }
    }
    provBox.append(custom);
    // Add form.
    const add = el('div', { class: 'mcp-add' });
    const fId = el('input', { class: 'settings-text', placeholder: 'id, e.g. my-llm' }) as HTMLInputElement;
    const fUrl = el('input', { class: 'settings-text', placeholder: 'https://…/v1 (OpenAI-compatible base URL)' }) as HTMLInputElement;
    const fKey = el('input', { class: 'settings-text', placeholder: 'env:NAME or key (optional, plaintext)', type: 'password' }) as HTMLInputElement;
    const fModels = el('input', { class: 'settings-text', placeholder: 'models, comma separated' }) as HTMLInputElement;
    const fSave = el('button', { class: 'btn btn-primary btn-sm' }, 'Save provider') as HTMLButtonElement;
    fSave.onclick = () => {
      void (async () => {
        const entry: CustomProviderEntry = {
          id: fId.value.trim(),
          baseURL: fUrl.value.trim(),
          apiKey: fKey.value.trim(),
          models: parseModelIds(fModels.value),
        };
        const errs = validateProviderEntry(entry);
        if (errs.length) {
          hooks.toast(errs.join(' '), 'error');
          return;
        }
        try {
          const res = await barang().mcpConfig('read', { scope: 'managed' });
          const next = setProviderEntry(String(res?.text ?? ''), entry);
          await barang().mcpConfig('write', { scope: 'managed', text: next });
          fId.value = '';
          fUrl.value = '';
          fKey.value = '';
          fModels.value = '';
          await refreshProviders();
          hooks.toast(`Provider ${entry.id} saved — restart the agent server to apply.`, 'info');
        } catch (e) {
          hooks.toast((e as Error).message, 'error');
        }
      })();
    };
    add.append(fId, fUrl, fKey, fModels, fSave);
    provBox.append(add);
    const bar = el('div', { class: 'mcp-bar' });
    const btnRestart = el('button', { class: 'btn btn-sm' }, 'Restart agent server') as HTMLButtonElement;
    btnRestart.title = 'Applies saved provider changes (stops running work)';
    btnRestart.onclick = () => {
      void (async () => {
        const ok = await confirmDialog({
          title: 'Restart the agent server?',
          message: 'Saved provider changes apply on restart. Running work will stop.',
          confirmLabel: 'Restart',
          danger: true,
        });
        if (!ok) return;
        try {
          await barang().app.retryOpencode();
          hooks.toast('Agent server restarting…', 'info');
        } catch (e) {
          hooks.toast(`Restart failed: ${(e as Error).message}`, 'error');
        }
      })();
    };
    bar.append(btnRestart);
    provBox.append(bar);
    if (provState.path) provBox.append(el('p', { class: 'settings-note' }, `Global file: ${provState.path}`));
  }

  void refreshProviders().catch(() => {});

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
  const bracketBox = checkRow('Bracket pair colorization');
  const stickyBox = checkRow('Sticky scroll');

  // --- Sessions ---
  section('Sessions');
  const confirmBox = checkRow('Ask before deleting a session');

  // --- Notifications (Windows toast + taskbar badge + sound) ---
  section('Notifications');
  const notifEnabledBox = checkRow('Enable notifications');
  const notifDoneBox = checkRow('When a run finishes');
  const notifApprovalBox = checkRow('When approval is needed');
  const notifQuestionBox = checkRow('When the agent asks a question');
  const notifErrorBox = checkRow('When a run errors or goes quiet (stuck)');
  const notifNativeBox = checkRow('Windows toast when Barang is in the background');
  const notifTaskbarBox = checkRow('Taskbar badge + flashing when in the background');
  const notifToastBox = checkRow('In-app toast when Barang is focused');
  const notifSoundBox = checkRow('Play a sound');
  // Per-kind sounds (opencode-style: done / approval / error each pick a
  // builtin tone or one of your own vaulted files).
  const soundSelFor = (label: string, title: string) => {
    const row = el('div', { class: 'settings-row' });
    row.append(el('span', { class: 'settings-row-label' }, label));
    const sel = el('select', { class: 'settings-inline-sel', title }) as HTMLSelectElement;
    row.append(sel);
    body.append(row);
    return sel;
  };
  const doneSel = soundSelFor('Run finished sound', 'Sound when a run finishes');
  const approvalSel = soundSelFor('Approval sound', 'Sound when approval is needed');
  const questionSel = soundSelFor('Question sound', 'Sound when the agent asks a question');
  const errorSel = soundSelFor('Error sound', 'Sound when a run errors');
  const fillSoundSel = (sel: HTMLSelectElement, current: string, customs: Array<{ id: string; name: string }>) => {
    sel.innerHTML = '';
    for (const s of BUILTIN_SOUNDS) sel.append(el('option', { value: s.id }, s.label) as HTMLOptionElement);
    for (const c of customs) sel.append(el('option', { value: `custom:${c.id}` }, `${c.name} (custom)`) as HTMLOptionElement);
    const valid = [...sel.options].some((o) => o.value === current);
    sel.value = valid ? current : sel.options[0]?.value ?? '';
  };
  body.append(el('p', { class: 'settings-note' }, 'Your sounds: pick audio files (MP3, WAV, OGG) — they are copied into Barang storage and offered above.'));
  const customList = el('div', { class: 'settings-sound-list' });
  body.append(customList);
  const addRow = el('div', { class: 'settings-row' });
  const btnBrowseSound = el('button', { class: 'btn btn-sm' }, 'Add custom sound…') as HTMLButtonElement;
  addRow.append(btnBrowseSound);
  body.append(addRow);
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
  const previewWrap = el('span', { class: 'settings-vol-wrap' });
  const btnPlayDone = el('button', { class: 'btn btn-sm', title: 'Preview the run-finished sound' }, 'Done') as HTMLButtonElement;
  const btnPlayApproval = el('button', { class: 'btn btn-sm', title: 'Preview the approval sound' }, 'Approval') as HTMLButtonElement;
  const btnPlayQuestion = el('button', { class: 'btn btn-sm', title: 'Preview the question sound' }, 'Question') as HTMLButtonElement;
  const btnPlayError = el('button', { class: 'btn btn-sm', title: 'Preview the error sound' }, 'Error') as HTMLButtonElement;
  previewWrap.append(btnPlayDone, btnPlayApproval, btnPlayQuestion, btnPlayError);
  testRow.append(previewWrap);
  body.append(testRow);
  body.append(el('p', { class: 'settings-note' }, 'Built-in sounds are original synth tones shipped with Barang.'));

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
  const maximizedBox = checkRow('Start maximized');
  void appState()
    .then((s) => {
      maximizedBox.checked = s.startMaximized === true;
    })
    .catch(() => {
      maximizedBox.toggleAttribute('disabled', true);
    });

  // --- Layout ---
  section('Layout');
  const resetRow = el('div', { class: 'settings-row' });
  resetRow.append(el('span', { class: 'settings-row-label' }, 'Panel sizes'));
  const btnResetLayout = el('button', { class: 'btn btn-sm' }, 'Reset to defaults');
  resetRow.append(btnResetLayout);
  body.append(resetRow);

  // Nav rail as tab pages (one section visible at a time — scannable like
  // VSCode's settings UI, no endless scroll). Each section's flat nodes are
  // grouped into a real page container holding direct references — no index
  // or lookup arithmetic that can desync between clicks.
  const content = el('div', { class: 'settings-content' });
  const nav = el('nav', { class: 'settings-nav', role: 'tablist', 'aria-label': 'Settings sections' });
  const navBtns = new Map<string, HTMLButtonElement>();
  const pageEls = new Map<string, HTMLElement>();
  const setActiveNav = (t: string) => {
    for (const [name, b] of navBtns) {
      b.classList.toggle('active', name === t);
      b.setAttribute('aria-selected', name === t ? 'true' : 'false');
    }
  };
  const showPage = (t: string) => {
    // Hide by identity: everything under body that isn't the active page
    // div stays hidden — even nodes appended after grouping (none expected)
    // can never leak across tabs.
    const active = pageEls.get(t) ?? null;
    for (const k of [...body.children]) {
      if (k instanceof HTMLElement) k.classList.toggle('hidden', k !== active);
    }
    body.scrollTop = 0;
    setActiveNav(t);
    // Fire the section's on-show hook (e.g. Usage re-fetches live data).
    onShow.get(t)?.();
  };
  const groupPages = () => {
    // Snapshot first: moving nodes while iterating a live list corrupts it.
    const kids = [...body.children] as HTMLElement[];
    let cur: HTMLElement | null = null;
    for (const k of kids) {
      if (k.classList.contains('settings-label') && k.id.startsWith('sec-')) {
        const t = SECTIONS.find((x) => secSlug(x) === k.id);
        cur = null;
        if (t) {
          let page = pageEls.get(t);
          if (!page) {
            page = el('div', { class: 'settings-page' });
            page.dataset.section = t;
            pageEls.set(t, page);
          }
          page.append(k);
          cur = page;
        }
        continue;
      }
      if (cur) cur.append(k);
      // Nodes before the first label stay put (none expected).
    }
    // Pages in section order; every section gets one even if empty.
    for (const t of SECTIONS) {
      let page = pageEls.get(t);
      if (!page) {
        page = el('div', { class: 'settings-page' });
        page.dataset.section = t;
        pageEls.set(t, page);
      }
      body.append(page);
    }
  };
  for (const t of SECTIONS) {
    const b = el('button', { class: 'settings-nav-item', role: 'tab' }) as HTMLButtonElement;
    b.textContent = t;
    b.onclick = () => showPage(t);
    nav.append(b);
    navBtns.set(t, b);
  }
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
    modelSel.append(el('option', { value: '' }, 'Auto (Kilo Code default)') as HTMLOptionElement);
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
    // (e.g. provider list changed since it was picked). Look the active model
    // up in the (enriched) list so the authoritative isFree flag is used.
    const s0 = agentStore.get();
    const st0 = readSettings();
    const activeEntry = s0.model
      ? s0.providerModels.find((m) => m.providerID === s0.model!.providerID && m.modelID === s0.model!.modelID)
      : undefined;
    if (st0.freeOnly && s0.model && !isFreeKiloModel(activeEntry ?? s0.model)) {
      const d = pickDefaultModel(s0.providerModels.filter((m) => isFreeKiloModel(m)));
      st0.model = d;
      writeSettings(st0);
      agentStore.set({ model: d });
      return; // subscribe re-fires paint with consistent state
    }
    freeBox.checked = st0.freeOnly;
    relayBox.checked = st0.opencodeRelay;
    relayAutoBox.checked = st0.opencodeRelayAuto;
    usageBox.checked = st0.showUsage;
    fullAutoBox.checked = st0.agentFullAuto;
    reasonBox.checked = st0.showReasoning;
    activityBox.checked = st0.showActivity;
    minimapBox.checked = st0.minimap;
    wrapBox.checked = st0.wordWrap;
    bracketBox.checked = st0.bracketColors;
    stickyBox.checked = st0.stickyScroll;
    confirmBox.checked = st0.confirmDelete;
    fontSel.value = String(st0.fontSize);
    notifEnabledBox.checked = st0.notifEnabled;
    notifDoneBox.checked = st0.notifOnDone;
    notifApprovalBox.checked = st0.notifOnApproval;
    notifQuestionBox.checked = st0.notifOnQuestion;
    notifErrorBox.checked = st0.notifOnError;
    notifNativeBox.checked = st0.notifNative;
    notifTaskbarBox.checked = st0.notifTaskbar;
    notifToastBox.checked = st0.notifToastFocused;
    notifSoundBox.checked = st0.notifSound;
    fillSoundSel(doneSel, st0.notifDoneSound, st0.notifCustomSounds);
    fillSoundSel(approvalSel, st0.notifApprovalSound, st0.notifCustomSounds);
    fillSoundSel(questionSel, st0.notifQuestionSound, st0.notifCustomSounds);
    fillSoundSel(errorSel, st0.notifErrorSound, st0.notifCustomSounds);
    paintCustomSounds(st0.notifCustomSounds);
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
      // the agent disagreeing — switch to the free default instead. Use the
      // enriched entry (authoritative isFree) when available.
      const s0 = agentStore.get();
      const cur = s0.model;
      const curEntry = cur ? s0.providerModels.find((m) => m.providerID === cur.providerID && m.modelID === cur.modelID) : undefined;
      if (settings.freeOnly && cur && !isFreeKiloModel(curEntry ?? cur)) {
        const d = pickDefaultModel(s0.providerModels.filter((m) => isFreeKiloModel(m)));
        settings.model = d;
        agentStore.set({ model: d });
        hooks.toast(d ? `Switched to ${d.providerID}/${d.modelID} (free Kilo Code models only).` : 'Switched to Auto (free Kilo Code models only).', 'info');
      }
    });
  };
  modelSel.onchange = () => {
    applyModelSelection(modelSel.value);
  };
  relayBox.onchange = () => {
    commit((s) => { s.opencodeRelay = relayBox.checked; });
    hooks.toast(relayBox.checked
      ? 'CLI Relay on — Kilo Code models go through your local CLI.'
      : 'CLI Relay off — Kilo Code models use serve.', 'info');
  };
  relayAutoBox.onchange = () => {
    commit((s) => { s.opencodeRelayAuto = relayAutoBox.checked; });
    hooks.toast(relayAutoBox.checked
      ? 'Relay auto-approve on — anything not denied passes without asking.'
      : 'Relay auto-approve off — relayed runs may stall on permission prompts.', 'info');
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
  bracketBox.onchange = () => {
    commit((s) => { s.bracketColors = bracketBox.checked; });
    applyEditorPrefs();
  };
  stickyBox.onchange = () => {
    commit((s) => { s.stickyScroll = stickyBox.checked; });
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
  notifQuestionBox.onchange = () => commit((s) => { s.notifOnQuestion = notifQuestionBox.checked; });
  notifErrorBox.onchange = () => commit((s) => { s.notifOnError = notifErrorBox.checked; });
  notifNativeBox.onchange = () => commit((s) => { s.notifNative = notifNativeBox.checked; });
  notifTaskbarBox.onchange = () => commit((s) => { s.notifTaskbar = notifTaskbarBox.checked; });
  notifToastBox.onchange = () => commit((s) => { s.notifToastFocused = notifToastBox.checked; });
  notifSoundBox.onchange = () => commit((s) => { s.notifSound = notifSoundBox.checked; });
  const paintCustomSounds = (customs: Array<{ id: string; name: string; fileUrl: string }>) => {
    customList.innerHTML = '';
    if (!customs.length) {
      customList.append(el('p', { class: 'settings-note' }, 'No custom sounds yet.'));
      return;
    }
    for (const c of customs) {
      const row = el('div', { class: 'settings-row' });
      const name = el('span', { class: 'settings-row-label sound-row-name' }, c.name);
      const acts = el('div', { class: 'sound-acts' });
      const btnPlay = el('button', { class: 'btn btn-sm', title: `Preview ${c.name}` }, 'Play') as HTMLButtonElement;
      btnPlay.onclick = () => {
        const s = readSettings();
        void playNotificationSound(c.fileUrl, s.notifVolume / 100).then((ok) => {
          if (!ok) hooks.toast('Could not play that sound (format or autoplay blocked — click anywhere and retry).', 'error');
        });
      };
      const btnDel = el('button', { class: 'btn btn-sm', title: `Remove ${c.name}` }, 'Remove') as HTMLButtonElement;
      btnDel.onclick = () => void removeCustomSound(c.id, c.name);
      acts.append(btnPlay, btnDel);
      row.append(name, acts);
      customList.append(row);
    }
  };
  doneSel.onchange = () => commit((s) => { s.notifDoneSound = doneSel.value; });
  approvalSel.onchange = () => commit((s) => { s.notifApprovalSound = approvalSel.value; });
  questionSel.onchange = () => commit((s) => { s.notifQuestionSound = questionSel.value; });
  errorSel.onchange = () => commit((s) => { s.notifErrorSound = errorSel.value; });
  const previewKind = (kind: 'done' | 'approval' | 'question' | 'error') => {
    const s = readSettings();
    const url = resolveKindSound(
      kind,
      { done: s.notifDoneSound, approval: s.notifApprovalSound, question: s.notifQuestionSound, error: s.notifErrorSound },
      s.notifCustomSounds,
    );
    if (!url) {
      hooks.toast('No sound configured.', 'info');
      return;
    }
    void playNotificationSound(url, s.notifVolume / 100).then((ok) => {
      if (!ok) hooks.toast('Could not play that sound (format or autoplay blocked — click anywhere and retry).', 'error');
    });
  };
  btnPlayDone.onclick = () => previewKind('done');
  btnPlayApproval.onclick = () => previewKind('approval');
  btnPlayQuestion.onclick = () => previewKind('question');
  btnPlayError.onclick = () => previewKind('error');
  async function browseSound() {
    try {
      const r = await barang().app.pickSound();
      commit((s) => {
        const list = [...s.notifCustomSounds, { id: r.id, name: r.name.slice(0, 120), fileUrl: r.fileUrl }].slice(-20);
        s.notifCustomSounds = list;
      });
      paint();
      hooks.toast(`Custom sound: ${r.name} — pick it in the rows above.`, 'info');
    } catch (e) {
      if (!/cancelled/i.test((e as Error).message)) hooks.toast(`Sound picker failed: ${(e as Error).message}`, 'error');
    }
  }
  async function removeCustomSound(id: string, name: string) {
    commit((s) => {
      s.notifCustomSounds = s.notifCustomSounds.filter((c) => c.id !== id);
    });
    paint();
    if (id !== 'legacy') {
      try {
        await barang().app.removeSound(id);
      } catch (e) {
        hooks.toast(`Entry removed, but the file stayed: ${(e as Error).message}`, 'error');
        return;
      }
    }
    hooks.toast(`Removed ${name}. Kinds using it fall back to their default tone.`, 'info');
  }
  btnBrowseSound.onclick = () => void browseSound();
  volInput.onchange = () => {
    commit((s) => { s.notifVolume = parseInt(volInput.value, 10) || 0; });
  };
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
  maximizedBox.onchange = () => {
    void barang()
      .app.setStartMaximized(maximizedBox.checked)
      .then((r) => {
        maximizedBox.checked = r.startMaximized;
        hooks.toast(r.startMaximized ? 'Will start maximized.' : 'Will start windowed.', 'info');
      })
      .catch((e) => {
        maximizedBox.checked = !maximizedBox.checked;
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

  // --- Skills (Qoder-compatible SKILL.md scopes) ---
  section('Skills');
  const skillsBox = el('div', { class: 'settings-skills' });
  body.append(skillsBox);
  body.append(el('p', { class: 'settings-note' },
    'Skills are reusable instruction packs the agent loads on demand. Bundled skills ship with ' +
    'Barang; project skills live in .barang/skills (shared via git); user skills apply to every project. ' +
    'Type /skill:<name> in the composer to load one for a turn.'));
  const skillsState: { list: Array<{ scope: 'bundled' | 'user' | 'project'; name: string; description: string; body: string; file: string }>; loading: boolean } = {
    list: [], loading: true,
  };
  const skillsPaint = () => {
    skillsBox.innerHTML = '';
    if (skillsState.loading) {
      skillsBox.append(el('div', { class: 'scm-none' }, 'Loading skills…'));
      return;
    }
    const groups = skillsByScope(skillsState.list as never);
    const order: Array<'bundled' | 'user' | 'project'> = ['bundled', 'user', 'project'];
    const labels = { bundled: 'Bundled', user: 'User', project: 'Project (.barang/skills)' };
    for (const scope of order) {
      const list = groups[scope] || [];
      if (!list.length && scope !== 'project') continue;
      const head = el('div', { class: 'settings-subhead' });
      head.append(el('span', {}, labels[scope]), el('span', { class: 'muted' }, String(list.length)));
      skillsBox.append(head);
      for (const sk of list) {
        const row = el('div', { class: 'skill-row' });
        row.append(el('div', { class: 'skill-name' }, sk.name));
        row.append(el('div', { class: 'skill-desc' }, (sk.description || 'No description.').slice(0, 140)));
        if (scope === 'project') {
          const del = el('button', { class: 'btn btn-sm', title: 'Delete skill' }, 'Delete') as HTMLButtonElement;
          del.onclick = () => void skillsDelete(sk.name);
          row.append(del);
        }
        skillsBox.append(row);
      }
    }
    const add = el('div', { class: 'settings-add-row' });
    const nameIn = el('input', { class: 'settings-input', placeholder: 'skill-name (project)' }) as HTMLInputElement;
    const fileIn = el('input', { class: 'settings-input', placeholder: 'SKILL.md text or leave to scaffold' }) as HTMLInputElement;
    const btnAdd = el('button', { class: 'btn btn-sm' }, 'Add project skill') as HTMLButtonElement;
    btnAdd.onclick = () => void skillsAdd(nameIn.value, fileIn.value);
    add.append(nameIn, fileIn, btnAdd);
    skillsBox.append(add);
  };
  const skillsRefresh = async () => {
    skillsState.loading = true;
    skillsPaint();
    try {
      const raw = await loadSkills();
      const records = await barang().skills.list();
      skillsState.list = records.map((r) => {
        const sk = parseSkillMarkdown(r.text, { scope: r.scope, dir: r.dir, path: r.path, file: r.file });
        return { scope: r.scope, name: sk?.name || r.dir, description: sk?.description || '', body: sk?.body || '', file: r.file };
      });
      // keep the parsed list authoritative for future paint calls
      void raw;
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
    skillsState.loading = false;
    skillsPaint();
  };
  const skillsAdd = async (name: string, text: string) => {
    const slug = name.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      hooks.toast('Bad skill name (lowercase letters, numbers, dashes).', 'error');
      return;
    }
    const body = text.trim() || `# ${slug}\n\nDescribe when to use this skill and the steps to follow.\n`;
    const md = `---\nname: ${slug}\ndescription: Use when … (one-line summary).\n---\n\n${body}`;
    try {
      await barang().skills.write(slug, md);
      hooks.toast(`Skill "${slug}" saved to .barang/skills.`, 'info');
      await skillsRefresh();
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
  };
  const skillsDelete = async (name: string) => {
    const okd = await confirmDialog({ title: `Delete skill "${name}"?`, message: 'Removes the project skill directory.', danger: true });
    if (!okd) return;
    try {
      await barang().skills.remove(name);
      hooks.toast(`Skill "${name}" deleted.`, 'info');
      await skillsRefresh();
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
  };
  onShow.set('Skills', () => void skillsRefresh());

  // --- Repo map (local structural index injected each turn) ---
  section('Repo map');
  const repoMapBox = checkRow('Inject a repo map into each turn (local symbol index — no embeddings or cloud service)');
  repoMapBox.checked = readSettings().repoMapEnabled;
  repoMapBox.onchange = () => {
    commit((s) => { s.repoMapEnabled = repoMapBox.checked; });
  };
  body.append(el('p', { class: 'settings-note' },
    'Barang scans the open project for source files and their exported symbols, then prepends a compact ' +
    'map (paths + exports, capped at a few KB) so the agent can find the right files instead of guessing. ' +
    'Each turn lists only the files that match your request, plus the most-imported files for orientation. ' +
    'The index is local and in-memory: it rebuilds when files change and is cached for a few minutes.'));
  onShow.set('Repo map', () => { repoMapBox.checked = readSettings().repoMapEnabled; });

  // --- Memory (Qoder-style typed memory + MEMORY.md index) ---
  section('Memory');
  body.append(el('p', { class: 'settings-note' },
    'Memories persist facts and preferences across sessions. Relevant memories are injected into the ' +
    'agent context each turn. User memories apply to all projects; project memories live in .barang/memory.'));
  const memAutoBox = checkRow('Auto-update memory after each turn (runs a quick background extraction — one extra model call)');
  memAutoBox.checked = readSettings().memoryAutoUpdate;
  memAutoBox.onchange = () => {
    commit((s) => { s.memoryAutoUpdate = memAutoBox.checked; });
  };
  const memBox = el('div', { class: 'settings-memory' });
  body.append(memBox);
  const memState: { entries: Array<{ scope: 'user' | 'project'; slug: string; title: string; hook: string; type: string; body: string; file: string; mtime: number }>; loading: boolean } = {
    entries: [], loading: true,
  };
  const memPaint = () => {
    memBox.innerHTML = '';
    if (memState.loading) {
      memBox.append(el('div', { class: 'scm-none' }, 'Loading memories…'));
      return;
    }
    const sorted = memState.entries.slice().sort((a, b) => {
      const order = ['user', 'feedback', 'project', 'reference'];
      const t = order.indexOf(a.type) - order.indexOf(b.type);
      return t || a.title.localeCompare(b.title);
    });
    for (const e of sorted) {
      const row = el('div', { class: 'memory-row' });
      const head = el('div', { class: 'memory-head' });
      head.append(el('span', { class: `memory-type is-${e.type}` }, e.type));
      head.append(el('span', { class: 'memory-title' }, e.title));
      head.append(el('span', { class: 'muted' }, e.scope));
      const del = el('button', { class: 'btn btn-sm', title: 'Delete memory' }, '×') as HTMLButtonElement;
      del.onclick = () => void memDelete(e.scope, e.slug);
      head.append(del);
      row.append(head);
      row.append(el('div', { class: 'memory-hook' }, (e.hook || '').slice(0, 160)));
      memBox.append(row);
    }
    const add = el('div', { class: 'settings-add-row' });
    const slugIn = el('input', { class: 'settings-input', placeholder: 'slug (e.g. user-role)' }) as HTMLInputElement;
    const titleIn = el('input', { class: 'settings-input', placeholder: 'Title' }) as HTMLInputElement;
    const typeSel = el('select', { class: 'settings-input' }) as HTMLSelectElement;
    for (const t of ['user', 'feedback', 'project', 'reference']) typeSel.append(el('option', { value: t }, t));
    const scopeSel = el('select', { class: 'settings-input' }) as HTMLSelectElement;
    scopeSel.append(el('option', { value: 'project' }, 'project'));
    scopeSel.append(el('option', { value: 'user' }, 'user'));
    const bodyIn = el('input', { class: 'settings-input', placeholder: 'Memory body (markdown)' }) as HTMLInputElement;
    const btnAdd = el('button', { class: 'btn btn-sm' }, 'Add memory') as HTMLButtonElement;
    btnAdd.onclick = () => void memAdd({
      slug: slugIn.value, title: titleIn.value, type: (typeSel.value || 'project') as never,
      scope: (scopeSel.value || 'project') as never, body: bodyIn.value,
    });
    add.append(slugIn, titleIn, typeSel, scopeSel, bodyIn, btnAdd);
    memBox.append(add);
  };
  const memRefresh = async () => {
    memState.loading = true;
    memPaint();
    try {
      const found = await barang().memory.discover();
      const parse = (list: Array<{ scope: 'user' | 'project'; slug: string; file: string; mtime: number; text: string }>) =>
        (list || [])
          .map((r) => parseMemoryMarkdown(r.text, { slug: r.slug, scope: r.scope, file: r.file, mtime: r.mtime }))
          .filter((m): m is NonNullable<typeof m> => !!m);
      memState.entries = [...parse(found.user), ...parse(found.project)];
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
    memState.loading = false;
    memPaint();
  };
  const memAdd = async (input: { slug: string; title: string; type: 'user' | 'feedback' | 'project' | 'reference'; scope: 'user' | 'project'; body: string }) => {
    const errs = validateMemoryInput(input);
    if (errs.length) {
      hooks.toast(errs[0], 'error');
      return;
    }
    const text = serializeMemory({
      slug: input.slug.trim(), title: input.title.trim(), hook: input.body.trim().split(/\n/)[0].slice(0, 160),
      type: input.type, scope: input.scope, body: input.body,
    });
    try {
      await barang().memory.write(input.scope, input.slug.trim(), text);
      // upsert the MEMORY.md index line
      const found = await barang().memory.discover();
      const idx = input.scope === 'user' ? found.userIndex : found.projectIndex;
      const line = upsertIndexLine(idx, { slug: input.slug.trim(), title: input.title.trim(), hook: input.body.trim().split(/\n/)[0].slice(0, 160) });
      await barang().memory.writeIndex(input.scope, line);
      hooks.toast(`Memory "${input.title.trim()}" saved (${input.scope}).`, 'info');
      await memRefresh();
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
  };
  const memDelete = async (scope: 'user' | 'project', slug: string) => {
    const okd = await confirmDialog({ title: `Delete memory "${slug}"?`, message: 'Removes the memory file and its index line.', danger: true });
    if (!okd) return;
    try {
      await barang().memory.remove(scope, slug);
      const found = await barang().memory.discover();
      const idx = scope === 'user' ? found.userIndex : found.projectIndex;
      await barang().memory.writeIndex(scope, removeIndexLine(idx, slug));
      hooks.toast(`Memory "${slug}" deleted.`, 'info');
      await memRefresh();
    } catch (e) {
      hooks.toast((e as Error).message, 'error');
    }
  };
  onShow.set('Memory', () => {
    memAutoBox.checked = readSettings().memoryAutoUpdate;
    void memRefresh();
  });

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
  const link = el('a', { href: 'https://kilo.ai', target: '_blank', rel: 'noreferrer' }, 'Kilo Code');
  credit.append(link, '.');
  about.append(credit);
  body.append(about);
  void appState()
    .then((s) => {
      const commit = typeof __BARANG_COMMIT__ !== 'undefined' ? __BARANG_COMMIT__ : 'dev';
      aboutVer.textContent = `v${s.versions.app} · ${commit} · Kilo Code ${s.opencode.version ?? s.opencode.cli ?? ''}`.trim();
    })
    .catch(() => {
      aboutVer.textContent = '';
    });

  agentStore.subscribe(paint);
  void loadMeta().then(paint).catch((e) => hooks.toast(`Kilo Code metadata: ${e.message}`, 'error'));
  paint();
  // Group AFTER every section (About is built last) — anything left loose
  // in body would show on every tab.
  groupPages();
  showPage(SECTIONS[0]); // tabbed: first page visible, rest hidden
}
