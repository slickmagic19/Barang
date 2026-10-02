// Bolt — unlimited local API client (Thunder Client without limits).
// Third sidebar view: collections persisted on this machine (localStorage),
// environments with {{var}} substitution, history, import/export, and an
// explicit project mirror (.barang/bolt/*.json) the agent can read + curl.
// Requests open as editor tabs (bolt:<id>); sending runs in main (no CORS).
import { fsApi } from '../lib/api';
import { barang } from '../lib/transport';
import { el } from '../lib/util';
import { iconEl } from './icons';
import { showContextMenu } from './menu';
import { confirmDialog, promptDialog } from './dialog';
import { editorStore } from './editor';

export interface BoltKV { id: string; key: string; value: string; enabled: boolean }
export interface BoltAuth { type: 'none' | 'bearer' | 'basic'; bearer: string; user: string; pass: string }
export interface BoltBody { type: 'none' | 'json' | 'text' | 'form'; text: string; form: BoltKV[] }
export interface BoltRequest {
  id: string; name: string; method: string; url: string;
  params: BoltKV[]; headers: BoltKV[]; auth: BoltAuth; body: BoltBody; updatedAt: number;
}
export interface BoltCollection { id: string; name: string; requests: BoltRequest[] }
export interface BoltEnv { id: string; name: string; vars: BoltKV[] }
interface BoltData { collections: BoltCollection[]; envs: BoltEnv[]; activeEnvId: string | null; autoMirror: boolean }
export interface BoltHistItem { id: string; time: number; method: string; url: string; status: number | null; ms: number; req: BoltRequest }
export interface ApiResponse {
  ok: boolean; status?: number; statusText?: string; url?: string; ms?: number;
  size?: number; truncated?: boolean; headers?: Record<string, string>; body?: string; error?: string;
}

export interface BoltHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  onTabs(): void;
}

const LS_DATA = 'barang:bolt-v1';
const LS_HIST = 'barang:bolt-hist-v1';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_COLORS: Record<string, string> = {
  GET: '#73c991', POST: '#e2c08d', PUT: '#62aef7', PATCH: '#b07fe8',
  DELETE: '#f14c4c', HEAD: '#8a8a8a', OPTIONS: '#8a8a8a',
};

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function kv(): BoltKV {
  return { id: uid(), key: '', value: '', enabled: true };
}

/** {{name}} substitution (whitespace-tolerant). Unknown vars stay literal. */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, name) => (name in vars ? vars[name] : m));
}

/** Merge enabled params into a base URL (preserves its existing query). Never throws. */
export function buildUrl(base: string, params: BoltKV[]): string {
  const enabled = params.filter((p) => p.enabled && p.key);
  if (!enabled.length) return base;
  const extra = enabled.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  try {
    const u = new URL(base, 'http://bolt.local');
    const q = u.search ? u.search.slice(1) + '&' + extra : extra;
    u.search = q;
    const s = u.toString();
    return base.startsWith('http') ? s : s.replace('http://bolt.local', '');
  } catch {
    return base + (base.includes('?') ? '&' : '?') + extra;
  }
}

/** Parse a URL's query string back into params (URL-edit → table sync). */
export function parseUrlParams(url: string): BoltKV[] {
  try {
    const u = new URL(url, 'http://bolt.local');
    const out: BoltKV[] = [];
    u.searchParams.forEach((value, key) => out.push({ id: uid(), key, value, enabled: true }));
    return out;
  } catch {
    return [];
  }
}

function authHeader(auth: BoltAuth, vars: Record<string, string>): Record<string, string> {
  if (auth.type === 'bearer' && auth.bearer) {
    return { Authorization: `Bearer ${substituteVars(auth.bearer, vars)}` };
  }
  if (auth.type === 'basic' && (auth.user || auth.pass)) {
    const raw = `${substituteVars(auth.user, vars)}:${substituteVars(auth.pass, vars)}`;
    return { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(raw))) };
  }
  return {};
}

/** Pretty-print + tokenize JSON for colored display. Falls back to raw text. */
export function prettyBody(text: string): { pretty: string; isJson: boolean } {
  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && t.length < 1024 * 1024) {
    try {
      return { pretty: JSON.stringify(JSON.parse(t), null, 2), isJson: true };
    } catch {
      /* not JSON — raw */
    }
  }
  return { pretty: text, isJson: false };
}

export function highlightJson(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
    (m, str, _u, colon, lit) => {
      if (str) {
        const cls = colon ? 'jk' : 'js';
        return `<span class="${cls}">${str}</span>${colon ?? ''}`;
      }
      if (lit) return `<span class="jb">${lit}</span>`;
      return `<span class="jn">${m}</span>`;
    });
}

export function newRequest(name = 'Untitled request'): BoltRequest {
  return {
    id: uid(), name, method: 'GET', url: '', params: [], headers: [],
    auth: { type: 'none', bearer: '', user: '', pass: '' },
    body: { type: 'none', text: '', form: [] }, updatedAt: Date.now(),
  };
}

function slugify(name: string): string {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'collection').slice(0, 60);
}

// Module state (single Bolt per window).
let data: BoltData = { collections: [], envs: [], activeEnvId: null, autoMirror: false };
let hist: BoltHistItem[] = [];
let hooksRef: BoltHooks = { toast: () => undefined, onTabs: () => undefined };

function saveData() {
  try {
    localStorage.setItem(LS_DATA, JSON.stringify(data));
  } catch {
    /* quota — collections stay in memory this session */
  }
}

function saveHist() {
  try {
    localStorage.setItem(LS_HIST, JSON.stringify(hist.slice(0, 50)));
  } catch {
    /* noop */
  }
}

function loadAll() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.collections)) data.collections = p.collections;
      if (Array.isArray(p.envs)) data.envs = p.envs;
      if (typeof p.activeEnvId === 'string' || p.activeEnvId === null) data.activeEnvId = p.activeEnvId;
      data.autoMirror = p.autoMirror === true;
    }
  } catch {
    /* corrupt — start fresh */
  }
  if (!data.envs.length) {
    data.envs = [{ id: uid(), name: 'Globals', vars: [] }];
    data.activeEnvId = data.envs[0].id;
  }
  if (!data.envs.some((e) => e.id === data.activeEnvId)) data.activeEnvId = data.envs[0].id;
  try {
    const raw = localStorage.getItem(LS_HIST);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) hist = p.slice(0, 50);
    }
  } catch {
    /* noop */
  }
}

export function activeEnvVars(): Record<string, string> {
  const env = data.envs.find((e) => e.id === data.activeEnvId) ?? data.envs[0];
  const out: Record<string, string> = {};
  for (const v of env?.vars ?? []) if (v.enabled && v.key) out[v.key] = v.value;
  return out;
}

function findRequest(id: string): { col: BoltCollection | null; req: BoltRequest } | null {
  for (const col of data.collections) {
    const req = col.requests.find((r) => r.id === id);
    if (req) return { col, req };
  }
  const sc = scratch.get(id);
  if (sc) return { col: null, req: sc };
  return null;
}

/** Open-tab drafts (unsent edits live here, not in the store). */
const scratch = new Map<string, BoltRequest>();
interface TabView {
  draft: BoltRequest;
  response: ApiResponse | null;
  sending: boolean;
  els: {
    root: HTMLElement; method: HTMLSelectElement; url: HTMLInputElement; name: HTMLInputElement;
    subBtns: HTMLButtonElement[]; panes: Record<string, HTMLElement>;
    send: HTMLButtonElement; res: HTMLElement;
  } | null;
}
const views = new Map<string, TabView>(); // boltId -> live view (mounted tab only)

function markDirty(id: string) {
  editorStore.set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === `bolt:${id}` ? { ...t, dirty: true } : t)),
  }));
  hooksRef.onTabs();
}

export function initBolt(sideHost: HTMLElement, hooks: BoltHooks) {
  hooksRef = hooks;
  loadAll();
  paintSide(sideHost);
  // Tab closes anywhere (x, menus, batches): drop orphaned drafts/views.
  editorStore.subscribe(() => {
    const live = new Set(editorStore.get().tabs.map((t) => t.path));
    for (const id of [...views.keys()]) {
      if (!live.has(`bolt:${id}`)) {
        views.delete(id);
        if (!data.collections.some((c) => c.requests.some((r) => r.id === id))) scratch.delete(id);
      }
    }
  });
  const api = {
    /** Open a saved request (or focus its tab). */
    open(id: string) {
      const found = findRequest(id);
      if (!found) {
        hooks.toast('Request no longer exists.', 'error');
        return;
      }
      const path = `bolt:${id}`;
      const exists = editorStore.get().tabs.some((t) => t.path === path);
      if (!exists) {
        editorStore.set((s) => ({ tabs: [...s.tabs, { path, dirty: false }], active: path }));
      } else {
        editorStore.set({ active: path });
      }
      hooks.onTabs();
      this.activate(id);
    },
    /** Open an ad-hoc request (history replay, blank). Unsaved until stored. */
    openScratch(seed?: Partial<BoltRequest>) {
      const r = { ...newRequest('Untitled request'), ...seed, id: uid() };
      scratch.set(r.id, r);
      this.open(r.id);
    },
    newRequest(focusUrl = true) {
      this.openScratch();
      if (focusUrl) {
        requestAnimationFrame(() => {
          const v = views.get(editorStore.get().active?.slice(5) ?? '');
          v?.els?.url.focus();
        });
      }
    },
    activate(id: string) {
      persistBuilder();
      editorStore.set({ active: `bolt:${id}` });
      hooksRef.onTabs();
      renderBuilder(id);
    },
    tabName(id: string): string {
      const f = findRequest(id);
      return f?.req.name || 'Request';
    },
    tabMethod(id: string): string {
      return findRequest(id)?.req.method ?? 'GET';
    },
    /** Persist the mounted builder back to its draft (tab switches). */
    saveActiveTab(): boolean {
      const active = editorStore.get().active;
      if (!active?.startsWith('bolt:')) return false;
      const id = active.slice(5);
      persistBuilder();
      const v = views.get(id);
      const d = v?.draft;
      if (!d) return false;
      // The builder edits a live copy — write it back over the stored
      // object (collection member or scratch), never the stale original.
      d.updatedAt = Date.now();
      const inCol = data.collections.find((c) => c.requests.some((r) => r.id === id));
      if (inCol) {
        const i = inCol.requests.findIndex((r) => r.id === id);
        if (i >= 0) inCol.requests[i] = d;
      } else {
        // Scratch → file into My Collection (created on demand).
        let mine = data.collections.find((c) => c.name === 'My Collection');
        if (!mine) {
          mine = { id: uid(), name: 'My Collection', requests: [] };
          data.collections.unshift(mine);
        }
        if (!mine.requests.some((r) => r.id === id)) mine.requests.unshift(d);
        scratch.delete(id);
      }
      saveData();
      editorStore.set((s) => ({
        ...s,
        tabs: s.tabs.map((t) => (t.path === active ? { ...t, dirty: false } : t)),
      }));
      hooksRef.onTabs();
      paintSide(sideHost);
      if (data.autoMirror) void mirrorAll(true);
      return true;
    },
    refreshSidebar() {
      paintSide(sideHost);
    },
  };
  boltApiRef = api;
  return api;
}

export type BoltApi = ReturnType<typeof initBolt>;

/** Read the mounted builder DOM back into its draft (tab switch / save). */
function persistBuilder() {
  const active = editorStore.get().active;
  if (!active?.startsWith('bolt:')) return;
  const v = views.get(active.slice(5));
  if (!v?.els) return;
  v.draft = readBuilder(v.els);
}

/** Send the mounted request (or a bare draft headlessly — used by smoke). */
export async function sendDraft(draft: BoltRequest, onEvent?: (r: ApiResponse) => void): Promise<ApiResponse> {
  const env = activeEnvVars();
  const url = substituteVars(draft.url.trim(), env);
  if (!url) throw new Error('Enter a URL first.');
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  if (draft.body.type === 'json' && draft.body.text.trim()) {
    try {
      JSON.parse(draft.body.text);
    } catch {
      throw new Error('Body is not valid JSON.');
    }
  }
  const headers: Record<string, string> = {};
  for (const h of draft.headers) {
    if (h.enabled && h.key) headers[h.key] = substituteVars(h.value, env);
  }
  Object.assign(headers, authHeader(draft.auth, env));
  let bodyText: string | undefined;
  const ctKeys = Object.keys(headers).map((k) => k.toLowerCase());
  if (draft.body.type === 'json' && draft.body.text) {
    bodyText = substituteVars(draft.body.text, env);
    if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'application/json';
  } else if (draft.body.type === 'text' && draft.body.text) {
    bodyText = substituteVars(draft.body.text, env);
    if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'text/plain';
  } else if (draft.body.type === 'form') {
    const sp = new URLSearchParams();
    for (const f of draft.body.form) {
      if (f.enabled && f.key) sp.append(f.key, substituteVars(f.value, env));
    }
    const s = sp.toString();
    if (s) {
      bodyText = s;
      if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  const fullUrl = buildUrl(url, draft.params.map((p) => ({ ...p, key: substituteVars(p.key, env), value: substituteVars(p.value, env) })));
  const reqId = uid();
  try {
    const res = await barang().api.send({ reqId, method: draft.method, url: fullUrl, headers, body: bodyText, timeoutMs: 30000 });
    hist.unshift({
      id: uid(), time: Date.now(), method: draft.method, url: fullUrl,
      status: res.status, ms: res.ms, req: JSON.parse(JSON.stringify(draft)),
    });
    hist = hist.slice(0, 50);
    saveHist();
    onEvent?.(res);
    return res;
  } catch (e) {
    const err: ApiResponse = { ok: false, error: (e as Error).message };
    onEvent?.(err);
    throw e;
  }
}

function readBuilder(els: NonNullable<TabView['els']>): BoltRequest {
  // Reconstructed by the live builder (set on renderBuilder) — see below.
  return (els as unknown as { __read: () => BoltRequest }).__read();
}

// --- sidebar ---------------------------------------------------------------
function paintSide(host: HTMLElement) {
  host.innerHTML = '';
  const head = el('div', { class: 'bolt-side-head' });
  head.append(el('span', { class: 'bolt-side-title' }, 'BOLT'));
  const acts = el('div', { class: 'scm-sync' });
  const mkHead = (icon: 'plus' | 'download', title: string, run: () => void) => {
    const b = el('button', { class: 'icon-btn', title }) as HTMLButtonElement;
    b.append(iconEl(icon, 14));
    b.onclick = run;
    acts.append(b);
  };
  mkHead('plus', 'New request', () => boltNewRequest(true));
  mkHead('download', 'Import collection (Bolt or Thunder Client JSON)', () => void importFlow());
  head.append(acts);
  host.append(head);
  host.append(el('div', { class: 'bolt-side-sub' }, 'API client · stored on this machine'));

  // Environment ({{var}} substitution).
  const envSec = el('div', { class: 'scm-sec' });
  const envHead = el('div', { class: 'scm-sec-head' });
  envHead.append(el('span', { class: 'scm-sec-title' }, 'Environment'));
  const envSel = el('select', { class: 'bolt-env-select', title: 'Active environment' }) as HTMLSelectElement;
  for (const e of data.envs) envSel.append(el('option', { value: e.id }, e.name) as HTMLOptionElement);
  envSel.value = data.activeEnvId ?? data.envs[0]?.id ?? '';
  envSel.onchange = () => {
    data.activeEnvId = envSel.value;
    saveData();
  };
  envHead.append(envSel);
  envSec.append(envHead);
  const env = data.envs.find((e) => e.id === data.activeEnvId) ?? data.envs[0];
  if (env) {
    const box = el('div', { class: 'bolt-env-box' });
    for (const v of env.vars) box.append(envVarRow(env, v));
    const add = el('button', { class: 'bolt-kv-add' }, '+ Add variable') as HTMLButtonElement;
    add.onclick = () => {
      env.vars.push({ id: uid(), key: '', value: '', enabled: true });
      saveData();
      paintSide(host);
    };
    box.append(add);
    const envActs = el('div', { class: 'bolt-env-acts' });
    const bNew = el('button', { class: 'btn btn-sm' }, 'New env') as HTMLButtonElement;
    bNew.onclick = () => void (async () => {
      const name = await promptDialog({ title: 'New environment', placeholder: 'Staging', confirmLabel: 'Create' });
      if (!name) return;
      const e2: BoltEnv = { id: uid(), name, vars: [] };
      data.envs.push(e2);
      data.activeEnvId = e2.id;
      saveData();
      paintSide(host);
    })();
    const bDel = el('button', { class: 'btn btn-sm', title: 'Delete this environment' }, 'Delete') as HTMLButtonElement;
    bDel.toggleAttribute('disabled', data.envs.length <= 1);
    bDel.onclick = () => void (async () => {
      const ok = await confirmDialog({ title: 'Delete environment?', message: `"${env.name}" and its variables are removed.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      data.envs = data.envs.filter((e) => e.id !== env.id);
      data.activeEnvId = data.envs[0]?.id ?? null;
      saveData();
      paintSide(host);
    })();
    envActs.append(bNew, bDel);
    box.append(envActs);
    envSec.append(box);
  }
  host.append(envSec);

  // Collections.
  const collSec = el('div', { class: 'scm-sec' });
  const collHead = el('div', { class: 'scm-sec-head' });
  collHead.append(el('span', { class: 'scm-sec-title' }, 'Collections'));
  collHead.append(el('span', { class: 'scm-count' }, String(data.collections.reduce((a, c) => a + c.requests.length, 0))));
  collSec.append(collHead);
  if (!data.collections.length) {
    collSec.append(el('div', { class: 'scm-none' }, 'No collections yet — + creates your first request.'));
  }
  for (const col of data.collections) {
    const h = el('div', { class: 'scm-sec-head bolt-coll-head' });
    h.append(iconEl('folder', 13), el('span', { class: 'scm-sec-title' }, col.name), el('span', { class: 'scm-count' }, String(col.requests.length)));
    const tools = el('div', { class: 'scm-sec-tools' });
    const add = el('button', { class: 'icon-btn', title: `New request in ${col.name}` }) as HTMLButtonElement;
    add.append(iconEl('plus', 13));
    add.onclick = () => boltNewRequestIn(col.id);
    tools.append(add);
    h.append(tools);
    h.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      collectionMenu(col, e.clientX, e.clientY);
    };
    collSec.append(h);
    for (const r of col.requests) collSec.append(requestRow(r));
  }
  const newColl = el('button', { class: 'bolt-new-coll' }, '+ New collection') as HTMLButtonElement;
  newColl.onclick = () => void (async () => {
    const name = await promptDialog({ title: 'New collection', placeholder: 'My API', confirmLabel: 'Create' });
    if (!name) return;
    data.collections.push({ id: uid(), name, requests: [] });
    saveData();
    paintSide(host);
  })();
  collSec.append(newColl);
  host.append(collSec);

  // History.
  if (hist.length) {
    const hSec = el('div', { class: 'scm-sec' });
    const hHead = el('div', { class: 'scm-sec-head' });
    hHead.append(el('span', { class: 'scm-sec-title' }, 'History'));
    const clear = el('button', { class: 'icon-btn', title: 'Clear history' }) as HTMLButtonElement;
    clear.append(iconEl('trash', 13));
    clear.onclick = () => {
      hist = [];
      saveHist();
      paintSide(host);
    };
    const tbox = el('div', { class: 'scm-sec-tools' });
    tbox.append(clear);
    hHead.append(tbox);
    hSec.append(hHead);
    for (const h of hist.slice(0, 8)) {
      const row = el('button', { class: 'scm-row bolt-hist-row', title: `${h.method} ${h.url} — click to reopen` }) as HTMLButtonElement;
      row.append(el('span', { class: 'bolt-method', style: `color:${METHOD_COLORS[h.method] ?? '#8a8a8a'}` }, h.method));
      row.append(el('span', { class: 'scm-name' }, h.url));
      if (h.status !== null) row.append(el('span', { class: `bolt-status s${Math.floor(h.status / 100)}xx` }, String(h.status)));
      row.onclick = () => boltOpenScratch({ ...JSON.parse(JSON.stringify(h.req)), id: uid(), name: (h.req.name || h.method + ' ' + h.url).slice(0, 80) });
      hSec.append(row);
    }
    host.append(hSec);
  }

  // Agent mirror footer.
  const foot = el('div', { class: 'bolt-foot' });
  const syncBtn = el('button', { class: 'btn btn-sm' }, 'Sync to project') as HTMLButtonElement;
  syncBtn.title = 'Write collections to .barang/bolt/ so the agent can read + curl them';
  syncBtn.onclick = () => void mirrorAll(false);
  const autoLab = el('label', { class: 'bolt-auto' });
  const autoBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  autoBox.checked = data.autoMirror;
  autoBox.onchange = () => {
    data.autoMirror = autoBox.checked;
    saveData();
  };
  autoLab.append(autoBox, el('span', {}, 'Auto-sync'));
  foot.append(syncBtn, autoLab);
  foot.append(el('div', { class: 'bolt-hint' }, 'Tell the agent: “use the Bolt requests in .barang/bolt/”.'));
  host.append(foot);
}

function envVarRow(env: BoltEnv, v: BoltKV): HTMLElement {
  const row = el('div', { class: 'bolt-kv' });
  const on = el('input', { type: 'checkbox', class: 'bolt-check', title: 'Enable' }) as HTMLInputElement;
  on.checked = v.enabled;
  on.onchange = () => {
    v.enabled = on.checked;
    saveData();
  };
  const k = el('input', { class: 'bolt-kv-key', placeholder: 'name', value: v.key }) as HTMLInputElement;
  k.oninput = () => {
    v.key = k.value;
    saveData();
  };
  const val = el('input', { class: 'bolt-kv-val', placeholder: '{{value}} usable anywhere', value: v.value }) as HTMLInputElement;
  val.oninput = () => {
    v.value = val.value;
    saveData();
  };
  const del = el('button', { class: 'icon-btn', title: 'Delete variable' }) as HTMLButtonElement;
  del.append(iconEl('x', 12));
  del.onclick = () => {
    env.vars = env.vars.filter((x) => x.id !== v.id);
    saveData();
    const host = document.getElementById('view-api');
    if (host) paintSide(host);
  };
  row.append(on, k, val, del);
  return row;
}

function requestRow(r: BoltRequest): HTMLElement {
  const row = el('button', { class: 'scm-row bolt-req-row', title: `${r.method} ${r.url || '(no URL)'} — click to open` }) as HTMLButtonElement;
  row.setAttribute('data-req-id', r.id);
  row.append(el('span', { class: 'bolt-method', style: `color:${METHOD_COLORS[r.method] ?? '#8a8a8a'}` }, r.method));
  row.append(el('span', { class: 'scm-name' }, r.name || 'Untitled request'));
  row.onclick = () => boltOpenRequest(r.id);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'external', run: () => boltOpenRequest(r.id) },
      { label: 'Rename…', icon: 'pencil', run: () => void renameRequest(r) },
      { label: 'Duplicate', icon: 'clip', run: () => duplicateRequest(r) },
      {
        label: 'Delete…', icon: 'trash', run: () => void (async () => {
          const ok = await confirmDialog({ title: 'Delete request?', message: `"${r.name}" is removed from its collection.`, confirmLabel: 'Delete', danger: true });
          if (!ok) return;
          for (const c of data.collections) c.requests = c.requests.filter((x) => x.id !== r.id);
          saveData();
          const host = document.getElementById('view-api');
          if (host) paintSide(host);
        })(),
      },
    ]);
  };
  return row;
}

async function renameRequest(r: BoltRequest) {
  const name = await promptDialog({ title: 'Rename request', initial: r.name, confirmLabel: 'Rename' });
  if (!name) return;
  r.name = name;
  r.updatedAt = Date.now();
  saveData();
  const host = document.getElementById('view-api');
  if (host) paintSide(host);
}

function duplicateRequest(r: BoltRequest) {
  const copy: BoltRequest = { ...JSON.parse(JSON.stringify(r)), id: uid(), name: `${r.name} (copy)` };
  const col = data.collections.find((c) => c.requests.some((x) => x.id === r.id));
  (col?.requests ?? []).unshift(copy);
  saveData();
  const host = document.getElementById('view-api');
  if (host) paintSide(host);
}

function collectionMenu(col: BoltCollection, x: number, y: number) {
  showContextMenu(x, y, [
    { label: 'New Request Here', icon: 'plus', run: () => boltNewRequestIn(col.id) },
    { label: 'Rename…', icon: 'pencil', run: () => void renameCollection(col) },
    { label: 'Duplicate', icon: 'clip', run: () => duplicateCollection(col) },
    { label: 'Export JSON', icon: 'download', run: () => exportCollection(col) },
    { label: 'Sync to Project', icon: 'upload', run: () => void mirrorCollection(col, false) },
    {
      label: 'Delete…', icon: 'trash', run: () => void (async () => {
        const ok = await confirmDialog({ title: 'Delete collection?', message: `"${col.name}" and its ${col.requests.length} request(s) are removed.`, confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        data.collections = data.collections.filter((c) => c.id !== col.id);
        saveData();
        const host = document.getElementById('view-api');
        if (host) paintSide(host);
      })(),
    },
  ]);
}

async function renameCollection(col: BoltCollection) {
  const name = await promptDialog({ title: 'Rename collection', initial: col.name, confirmLabel: 'Rename' });
  if (!name) return;
  col.name = name;
  saveData();
  const host = document.getElementById('view-api');
  if (host) paintSide(host);
}

function duplicateCollection(col: BoltCollection) {
  const copy: BoltCollection = { ...JSON.parse(JSON.stringify(col)), id: uid(), name: `${col.name} (copy)` };
  copy.requests.forEach((r) => { r.id = uid(); });
  data.collections.push(copy);
  saveData();
  const host = document.getElementById('view-api');
  if (host) paintSide(host);
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 4000);
}

function exportCollection(col: BoltCollection) {
  downloadJson(`${slugify(col.name)}.bolt.json`, { app: 'barang-bolt', version: 1, collections: [col], environments: data.envs });
  hooksRef.toast(`Exported ${col.name}.`, 'info');
}

/** Import our format, single-collection files, or Thunder Client exports. */
function normalizeImport(obj: any): BoltCollection[] {
  const out: BoltCollection[] = [];
  const mkReq = (r: any): BoltRequest => {
    const kv = (list: any): BoltKV[] => (Array.isArray(list) ? list : []).map((e: any) => ({
      id: uid(),
      key: String(e.key ?? e.name ?? ''),
      value: String(e.value ?? ''),
      enabled: e.enabled !== false,
    }));
    const headers = kv(r.headers);
    let auth: BoltAuth = { type: 'none', bearer: '', user: '', pass: '' };
    const ah = headers.find((h) => h.key.toLowerCase() === 'authorization' && h.enabled);
    if (ah) {
      const mB = /^Bearer (.+)$/.exec(ah.value);
      const mB2 = /^Basic (.+)$/.exec(ah.value);
      if (mB) auth = { ...auth, type: 'bearer', bearer: mB[1] };
      else if (mB2) {
        try {
          const [u, ...rest] = atob(mB2[1]).split(':');
          auth = { ...auth, type: 'basic', user: u ?? '', pass: rest.join(':') };
        } catch {
          /* keep none */
        }
      }
    }
    let body: BoltBody = { type: 'none', text: '', form: [] };
    const b = r.body ?? r.bodyRaw;
    if (typeof b === 'string' && b) {
      const t = b.trim();
      body = { type: t.startsWith('{') || t.startsWith('[') ? 'json' : 'text', text: b, form: [] };
    } else if (b && typeof b === 'object') {
      if (Array.isArray((b as any).form)) body = { type: 'form', text: '', form: kv((b as any).form) };
      else if (typeof (b as any).raw === 'string') body = { type: 'json', text: (b as any).raw, form: [] };
    }
    if (Array.isArray(r.bodyForm)) body = { type: 'form', text: '', form: kv(r.bodyForm) };
    return {
      id: uid(), name: String(r.name ?? r.requestName ?? 'Imported request'),
      method: String(r.method ?? 'GET').toUpperCase(), url: String(r.url ?? r.requestUrl ?? ''),
      params: kv(r.params ?? r.queryParams), headers, auth, body, updatedAt: Date.now(),
    };
  };
  const cols: any[] = Array.isArray(obj?.collections) ? obj.collections : (obj?.requests ? [obj] : []);
  for (const c of cols) {
    if (!c || !Array.isArray(c.requests)) continue;
    out.push({
      id: uid(),
      name: String(c.name ?? c.collectionName ?? 'Imported collection'),
      requests: c.requests.map(mkReq),
    });
  }
  return out;
}

function importFlow() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const cols = normalizeImport(JSON.parse(String(rd.result)));
        if (!cols.length) throw new Error('no requests found');
        data.collections.push(...cols);
        saveData();
        const host = document.getElementById('view-api');
        if (host) paintSide(host);
        hooksRef.toast(`Imported ${cols.length} collection(s).`, 'info');
      } catch (e) {
        hooksRef.toast(`Import failed: ${(e as Error).message}`, 'error');
      }
    };
    rd.readAsText(f);
  };
  inp.click();
}

/** Mirror collections to .barang/bolt/ so the agent can read + curl them. */
async function mirrorCollection(col: BoltCollection, quiet: boolean) {
  const payload = {
    app: 'barang-bolt', version: 1, exportedAt: new Date().toISOString(),
    note: 'Mirrored by Barang Bolt for agent use. Requests carry {{variables}} — resolve from environments below or ask the user.',
    collection: { name: col.name, requests: col.requests },
    environments: data.envs,
  };
  try {
    await fsApi.write(`.barang/bolt/${slugify(col.name)}.json`, JSON.stringify(payload, null, 2));
    if (!quiet) hooksRef.toast(`Synced "${col.name}" to .barang/bolt/ for the agent.`, 'info');
  } catch (e) {
    if (!quiet) hooksRef.toast(`Sync failed (open a folder first): ${(e as Error).message}`, 'error');
  }
}

async function mirrorAll(quiet: boolean) {
  if (!data.collections.length) {
    if (!quiet) hooksRef.toast('Nothing to sync — no collections yet.', 'info');
    return;
  }
  for (const col of data.collections) await mirrorCollection(col, true);
  if (!quiet) hooksRef.toast(`Synced ${data.collections.length} collection(s) to .barang/bolt/.`, 'info');
}

// View-open helpers used by sidebar rows (indirection keeps paintSide lean).
function boltOpenRequest(id: string) {
  boltApiRef?.open(id);
}
function boltNewRequest(focus: boolean) {
  boltApiRef?.newRequest(focus);
}
function boltNewRequestIn(colId: string) {
  const col = data.collections.find((c) => c.id === colId);
  if (!col) return;
  const r = newRequest('Untitled request');
  col.requests.unshift(r);
  saveData();
  const host = document.getElementById('view-api');
  if (host) paintSide(host);
  boltApiRef?.open(r.id);
}
function boltOpenScratch(seed: Partial<BoltRequest>) {
  boltApiRef?.openScratch(seed);
}

// Set by initBolt below (sidebar painters above run after init).
let boltApiRef: BoltApi | null = null;

// --- builder (center tab) ------------------------------------------------------
function kvTable(list: BoltKV[], onMutate: () => void, valuePlaceholder = 'value'): HTMLElement {
  const box = el('div', { class: 'bolt-kv-box' });
  const render = () => {
    box.innerHTML = '';
    for (const item of list) {
      const row = el('div', { class: 'bolt-kv' });
      const on = el('input', { type: 'checkbox', class: 'bolt-check', title: 'Enable' }) as HTMLInputElement;
      on.checked = item.enabled;
      on.onchange = () => {
        item.enabled = on.checked;
        onMutate();
      };
      const k = el('input', { class: 'bolt-kv-key', placeholder: 'key', value: item.key }) as HTMLInputElement;
      k.oninput = () => {
        item.key = k.value;
        onMutate();
      };
      const val = el('input', { class: 'bolt-kv-val', placeholder: valuePlaceholder, value: item.value }) as HTMLInputElement;
      val.oninput = () => {
        item.value = val.value;
        onMutate();
      };
      const del = el('button', { class: 'icon-btn', title: 'Delete row' }) as HTMLButtonElement;
      del.append(iconEl('x', 12));
      del.onclick = () => {
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
        onMutate();
        render();
      };
      row.append(on, k, val, del);
      box.append(row);
    }
    const add = el('button', { class: 'bolt-kv-add' }, '+ Add row') as HTMLButtonElement;
    add.onclick = () => {
      list.push(kv());
      render();
      onMutate();
    };
    box.append(add);
  };
  render();
  return box;
}

function currentView(): TabView | null {
  const active = editorStore.get().active;
  if (!active?.startsWith('bolt:')) return null;
  return views.get(active.slice(5)) ?? null;
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 's2xx';
  if (status >= 300 && status < 400) return 's3xx';
  if (status >= 400 && status < 500) return 's4xx';
  return 's5xx';
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderBuilder(id: string) {
  const host = document.getElementById('bolt-host');
  if (!host) return;
  const found = findRequest(id);
  if (!found) return;
  let v = views.get(id);
  if (!v) {
    v = { draft: JSON.parse(JSON.stringify(found.req)), response: null, sending: false, els: null };
    views.set(id, v);
  }
  const view = v;
  const d = view.draft;
  host.innerHTML = '';
  const root = el('div', { class: 'bolt-req' });

  // Name + request line.
  const nameRow = el('div', { class: 'bolt-name-row' });
  const nameInput = el('input', { class: 'bolt-name', value: d.name, placeholder: 'Request name' }) as HTMLInputElement;
  nameInput.oninput = () => {
    d.name = nameInput.value;
    touchDirty();
  };
  nameRow.append(nameInput);
  const reqLine = el('div', { class: 'bolt-req-line' });
  const methodSel = el('select', { class: 'bolt-method-sel', title: 'Method' }) as HTMLSelectElement;
  for (const m of METHODS) methodSel.append(el('option', { value: m }, m) as HTMLOptionElement);
  methodSel.value = METHODS.includes(d.method) ? d.method : 'GET';
  methodSel.onchange = () => {
    d.method = methodSel.value;
    touchDirty();
  };
  const urlInput = el('input', { class: 'bolt-url', placeholder: 'https://api.example.com/users?page=2  ({{vars}} work everywhere)', value: d.url }) as HTMLInputElement;
  urlInput.oninput = () => {
    d.url = urlInput.value;
    touchDirty();
  };
  // URL edits re-parse the query into the params table (change = committed).
  urlInput.onchange = () => {
    const parsed = parseUrlParams(urlInput.value);
    if (parsed.length || d.params.length) {
      d.params = parsed;
      touchDirty();
      renderParamsPane();
    }
  };
  const sendBtn = el('button', { class: 'btn btn-primary btn-sm bolt-send' }, 'Send') as HTMLButtonElement;
  sendBtn.onclick = () => void doSend();
  reqLine.append(methodSel, urlInput, sendBtn);
  root.append(nameRow, reqLine);

  // Sub-tabs: Params | Headers | Auth | Body.
  const subBar = el('div', { class: 'bolt-subtabs' });
  const panes: Record<string, HTMLElement> = {};
  const subBtns: HTMLButtonElement[] = [];
  let curSub = 'params';
  const refreshBadges = () => {
    for (const b of subBtns) {
      const kk = b.dataset.btab;
      const n = kk === 'params' ? d.params.filter((p) => p.enabled && p.key).length
        : kk === 'headers' ? d.headers.filter((p) => p.enabled && p.key).length
        : kk === 'auth' ? (d.auth.type === 'none' ? 0 : 1)
        : (d.body.type === 'none' ? 0 : 1);
      b.querySelector('.bolt-sub-n')?.remove();
      if (n) b.append(el('span', { class: 'bolt-sub-n' }, String(n)));
    }
  };
  const touchDirtyAndBadges = () => {
    touchDirty();
    refreshBadges();
  };
  const renderParamsPane = () => {
    panes.params.innerHTML = '';
    panes.params.append(kvTable(d.params, () => {
      touchDirty();
      // Params edits rebuild the URL silently (no event loop: direct set).
      const base = urlInput.value.split('?')[0];
      const vars = activeEnvVars();
      const sub = d.params.map((p) => ({ ...p, key: substituteVars(p.key, vars), value: substituteVars(p.value, vars) }));
      urlInput.value = buildUrl(base, sub);
    }, '{{value}} or plain text'));
  };
  for (const key of ['params', 'headers', 'auth', 'body'] as const) {
    const b = el('button', { class: `bolt-subtab${key === curSub ? ' active' : ''}` }, key[0].toUpperCase() + key.slice(1)) as HTMLButtonElement;
    b.dataset.btab = key;
    b.onclick = () => {
      curSub = key;
      for (const x of subBtns) x.classList.toggle('active', x === b);
      for (const [k, pane] of Object.entries(panes)) pane.classList.toggle('hidden', k !== key);
    };
    subBtns.push(b);
    subBar.append(b);
  }
  const paneBox = el('div', { class: 'bolt-panes' });
  for (const key of ['params', 'headers', 'auth', 'body']) {
    const pane = el('div', { class: `bolt-pane${key === curSub ? '' : ' hidden'}` });
    panes[key] = pane;
    paneBox.append(pane);
  }
  panes.headers.append(kvTable(d.headers, touchDirtyAndBadges));
  // Auth pane.
  {
    const typeSel = el('select', { class: 'bolt-auth-sel', title: 'Auth type' }) as HTMLSelectElement;
    for (const [v, label] of [['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth']] as const) {
      typeSel.append(el('option', { value: v }, label) as HTMLOptionElement);
    }
    typeSel.value = d.auth.type;
    const fields = el('div', { class: 'bolt-auth-fields' });
    const paintAuth = () => {
      fields.innerHTML = '';
      if (d.auth.type === 'bearer') {
        const t = el('input', { class: 'bolt-text-input', placeholder: 'Token ({{vars}} ok)', value: d.auth.bearer }) as HTMLInputElement;
        t.oninput = () => {
          d.auth.bearer = t.value;
          touchDirty();
        };
        fields.append(t);
      } else if (d.auth.type === 'basic') {
        const u = el('input', { class: 'bolt-text-input', placeholder: 'Username', value: d.auth.user }) as HTMLInputElement;
        const p = el('input', { class: 'bolt-text-input', placeholder: 'Password', value: d.auth.pass }) as HTMLInputElement;
        p.type = 'password';
        u.oninput = () => {
          d.auth.user = u.value;
          touchDirty();
        };
        p.oninput = () => {
          d.auth.pass = p.value;
          touchDirty();
        };
        fields.append(u, p);
      }
    };
    typeSel.onchange = () => {
      d.auth.type = typeSel.value as BoltAuth['type'];
      touchDirtyAndBadges();
      paintAuth();
    };
    panes.auth.append(typeSel, fields);
    paintAuth();
  }
  // Body pane.
  {
    const typeSel = el('select', { class: 'bolt-body-sel', title: 'Body type' }) as HTMLSelectElement;
    for (const [v, label] of [['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form']] as const) {
      typeSel.append(el('option', { value: v }, label) as HTMLOptionElement);
    }
    typeSel.value = d.body.type;
    const fields = el('div', { class: 'bolt-body-fields' });
    const paintBody = () => {
      fields.innerHTML = '';
      if (d.body.type === 'json' || d.body.type === 'text') {
        const ta = el('textarea', { class: 'bolt-body-text', placeholder: d.body.type === 'json' ? '{\n  "key": "value"\n}' : 'Raw text body ({{vars}} ok)' }) as HTMLTextAreaElement;
        ta.value = d.body.text;
        ta.oninput = () => {
          d.body.text = ta.value;
          touchDirty();
        };
        fields.append(ta);
        if (d.body.type === 'json') {
          const fmt = el('button', { class: 'btn btn-sm' }, 'Format') as HTMLButtonElement;
          fmt.title = 'Pretty-print JSON';
          fmt.onclick = () => {
            try {
              ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
              d.body.text = ta.value;
              touchDirty();
            } catch {
              hooksRef.toast('Body is not valid JSON.', 'error');
            }
          };
          fields.append(fmt);
        }
      } else if (d.body.type === 'form') {
        fields.append(kvTable(d.body.form, touchDirty));
      }
    };
    typeSel.onchange = () => {
      d.body.type = typeSel.value as BoltBody['type'];
      touchDirtyAndBadges();
      paintBody();
    };
    panes.body.append(typeSel, fields);
    paintBody();
  }
  renderParamsPane();
  refreshBadges();
  root.append(subBar, paneBox);

  // Response pane.
  const resBox = el('div', { class: 'bolt-res' });
  root.append(resBox);
  const paintResponse = () => paintResPane(resBox, view);

  async function doSend() {
    persistDraftFromDom();
    const fresh = view.draft;
    if (view.sending) return;
    view.sending = true;
    sendBtn.textContent = 'Cancel';
    sendBtn.onclick = () => {
      void barang().api.cancel('bolt:' + id).catch(() => undefined);
    };
    const reqId = 'bolt:' + id;
    try {
      const vars = activeEnvVars();
      const url = substituteVars(fresh.url.trim(), vars);
      if (!url) throw new Error('Enter a URL first.');
      if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
      if (fresh.body.type === 'json' && fresh.body.text.trim()) {
        try {
          JSON.parse(fresh.body.text);
        } catch {
          throw new Error('Body is not valid JSON.');
        }
      }
      const headers: Record<string, string> = {};
      for (const h of fresh.headers) {
        if (h.enabled && h.key) headers[h.key] = substituteVars(h.value, vars);
      }
      Object.assign(headers, authHeader(fresh.auth, vars));
      let bodyText: string | undefined;
      const ctKeys = Object.keys(headers).map((k) => k.toLowerCase());
      if (fresh.body.type === 'json' && fresh.body.text) {
        bodyText = substituteVars(fresh.body.text, vars);
        if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'application/json';
      } else if (fresh.body.type === 'text' && fresh.body.text) {
        bodyText = substituteVars(fresh.body.text, vars);
        if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'text/plain';
      } else if (fresh.body.type === 'form') {
        const sp = new URLSearchParams();
        for (const f of fresh.body.form) {
          if (f.enabled && f.key) sp.append(f.key, substituteVars(f.value, vars));
        }
        const s = sp.toString();
        if (s) {
          bodyText = s;
          if (!ctKeys.includes('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      const fullUrl = buildUrl(url, fresh.params.map((p) => ({ ...p, key: substituteVars(p.key, vars), value: substituteVars(p.value, vars) })));
      const res = await barang().api.send({ reqId, method: fresh.method, url: fullUrl, headers, body: bodyText, timeoutMs: 30000 });
      view.response = res;
      hist.unshift({
        id: uid(), time: Date.now(), method: fresh.method, url: fullUrl,
        status: res.status, ms: res.ms, req: JSON.parse(JSON.stringify(fresh)),
      });
      hist = hist.slice(0, 50);
      saveHist();
      const host2 = document.getElementById('view-api');
      if (host2) paintSide(host2);
    } catch (e) {
      view.response = { ok: false, error: (e as Error).message };
    } finally {
      view.sending = false;
      sendBtn.textContent = 'Send';
      sendBtn.onclick = () => void doSend();
      paintResponse();
    }
  }

  function persistDraftFromDom() {
    view.draft.name = nameInput.value;
    view.draft.method = methodSel.value;
    view.draft.url = urlInput.value;
  }

  function touchDirty() {
    persistDraftFromDom();
    markDirty(id);
  }

  view.els = {
    root, method: methodSel, url: urlInput, name: nameInput,
    subBtns, panes, send: sendBtn, res: resBox,
    __read: () => {
      persistDraftFromDom();
      return view.draft;
    },
  } as unknown as NonNullable<TabView['els']>;
  host.append(root);
  paintResponse();
}

function paintResPane(box: HTMLElement, view: TabView) {
  box.innerHTML = '';
  const res = view.response;
  if (view.sending && !res) {
    box.append(el('div', { class: 'bolt-res-empty' }, 'Sending… (Cancel stops it)'));
    return;
  }
  if (!res) {
    box.append(el('div', { class: 'bolt-res-empty' }, 'Send a request to see the response here.'));
    return;
  }
  if (!res.ok) {
    const err = el('div', { class: 'bolt-res-error' });
    err.append(iconEl('alert', 14), el('span', {}, res.error ?? 'Request failed.'));
    box.append(err);
    return;
  }
  const head = el('div', { class: 'bolt-res-head' });
  head.append(el('span', { class: `bolt-status ${statusClass(res.status ?? 0)}` }, `${res.status} ${res.statusText ?? ''}`.trim()));
  head.append(el('span', { class: 'bolt-res-meta' }, `${res.ms ?? 0} ms · ${fmtSize(res.size ?? 0)}${res.truncated ? ' · truncated' : ''}`));
  const saveBtn = el('button', { class: 'icon-btn', title: 'Save response body to file' }) as HTMLButtonElement;
  saveBtn.append(iconEl('download', 13));
  saveBtn.onclick = () => {
    const blob = new Blob([res.body ?? ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bolt-response.txt';
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);
  };
  head.append(saveBtn);
  box.append(head);
  const tabs = el('div', { class: 'bolt-subtabs' });
  const bBody = el('button', { class: 'bolt-subtab active' }, 'Body') as HTMLButtonElement;
  const bHead = el('button', { class: 'bolt-subtab' }, 'Headers') as HTMLButtonElement;
  tabs.append(bBody, bHead);
  const bodyPane = el('div', { class: 'bolt-res-body' });
  const headPane = el('div', { class: 'bolt-res-headers hidden' });
  bBody.onclick = () => {
    bBody.classList.add('active');
    bHead.classList.remove('active');
    bodyPane.classList.remove('hidden');
    headPane.classList.add('hidden');
  };
  bHead.onclick = () => {
    bHead.classList.add('active');
    bBody.classList.remove('active');
    headPane.classList.remove('hidden');
    bodyPane.classList.add('hidden');
  };
  const raw = res.body ?? '';
  const shown = raw.length > 200000 ? raw.slice(0, 200000) : raw;
  const { pretty, isJson } = prettyBody(shown);
  const pre = el('pre', { class: 'bolt-pre' });
  if (isJson) {
    pre.innerHTML = highlightJson(pretty);
    const rawBtn = el('button', { class: 'btn btn-sm' }, 'Raw') as HTMLButtonElement;
    rawBtn.title = 'Show unformatted body';
    rawBtn.onclick = () => {
      pre.textContent = shown;
      rawBtn.remove();
    };
    bodyPane.append(rawBtn);
  } else {
    pre.textContent = shown;
  }
  bodyPane.append(pre);
  if (raw.length !== shown.length || res.truncated) {
    bodyPane.append(el('div', { class: 'scm-none' }, `Body truncated (${fmtSize(res.size ?? 0)} total) — Save downloads everything.`));
  }
  const entries = Object.entries(res.headers ?? {});
  if (!entries.length) headPane.append(el('div', { class: 'scm-none' }, 'No headers.'));
  for (const [k, v] of entries) {
    const row = el('div', { class: 'bolt-hrow' });
    row.append(el('span', { class: 'bolt-hkey' }, k), el('span', { class: 'bolt-hval' }, v));
    headPane.append(row);
  }
  box.append(tabs, bodyPane, headPane);
}
