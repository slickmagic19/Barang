// Agent state: opencode sessions, streaming refresh via the /event SSE bus,
// generic part rendering + permission approvals. Keeps no secrets — the
// bridge injects server auth; model auth lives in the user's opencode CLI.
import { oc } from './api';
import { barang } from './transport';
import { createStore, debounce } from './util';

export interface AgentInfo {
  name: string;
  description?: string;
  mode?: string;
}
export interface ProviderModel {
  id: string;
  name?: string;
}
export interface ProviderInfo {
  id: string;
  name?: string;
  models?: Record<string, unknown> | ProviderModel[];
}
export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string; // project root the session belongs to (opencode-owned)
  time?: { created?: number; updated?: number };
}
export interface MsgPart {
  type?: string;
  text?: string;
  [k: string]: unknown;
}
export interface ChatMessage {
  info?: { id?: string; role?: string; time?: { created?: number }; [k: string]: unknown };
  parts?: MsgPart[];
}
export interface PendingPermission {
  key: string;
  sessionID: string;
  permissionID: string;
  title: string;
  detail?: string;
}

interface AgentState {
  root: string; // open project folder — sessions are scoped to it
  sessions: SessionInfo[];
  activeId: string | null;
  messages: ChatMessage[];
  agents: AgentInfo[];
  providerModels: Array<{ providerID: string; modelID: string; label: string }>;
  model: { providerID: string; modelID: string } | null;
  agent: string;
  busy: boolean;
  status: string;
  permissions: PendingPermission[];
  connected: boolean;
  error: string | null;
}

export const agentStore = createStore<AgentState>({
  root: '',
  sessions: [],
  activeId: null,
  messages: [],
  agents: [],
  providerModels: [],
  model: null,
  agent: 'build',
  busy: false,
  status: 'idle',
  permissions: [],
  connected: false,
  error: null,
});

const scheduleRefresh = debounce(() => void refreshActive().catch(() => {}), 300);
const scheduleSessions = debounce(() => void loadSessions().catch(() => {}), 800);

let eventsConnected = false;

export function connectEvents() {
  if (eventsConnected) return;
  eventsConnected = true;
  // Upstream /event frames forwarded by the desktop main process.
  barang().events.onConn((c) => agentStore.set({ connected: c }));
  barang().events.subscribe((data: string) => {
    // Hot path (every streamed frame): match on the raw string. Parsing +
    // re-stringifying multi-MB frames here used to stall the UI.
    const blob = data.toLowerCase();
    if (blob.includes('permission')) {
      void refreshActive().catch(() => {});
      scheduleSessions();
      return;
    }
    if (
      blob.includes('message') || blob.includes('session') ||
      blob.includes('part') || blob.includes('todo') || blob.includes('diff')
    ) {
      scheduleRefresh();
      scheduleSessions();
    }
  });
}

export interface BarangSettings {
  model: { providerID: string; modelID: string } | null; // null = auto
  modelChosen: boolean; // explicit pick (even Auto) — boot defaults never override
  agent: string | null;
  freeOnly: boolean;
  showReasoning: boolean; // default false — reasoning rows hidden
  showActivity: boolean; // default false — step/tool rows hidden (text answers stay)
  confirmDelete: boolean; // default true — ask before deleting a session
  fontSize: number; // editor font size, default 13
  minimap: boolean; // editor minimap, default false
  wordWrap: boolean; // editor word wrap, default true
  termShell: string; // terminal shell path, '' = auto (PowerShell/$SHELL)
  termFont: number; // terminal font size, default 12 (VSCode)
  termScrollback: number; // terminal scrollback lines, default 1000
  termBlink: boolean; // terminal cursor blink, default true
  notifEnabled: boolean; // master switch, default true
  notifNative: boolean; // Windows toast when unfocused, default true
  notifSound: boolean; // play a sound, default true
  notifSoundName: string; // builtin id or 'custom', default 'chime'
  notifCustomName: string; // picked file display name
  notifCustomPath: string; // picked file file:// URL
  notifVolume: number; // 0-100, default 80
  notifOnDone: boolean; // notify when a run finishes, default true
  notifOnApproval: boolean; // notify on pending approvals, default true
  notifOnError: boolean; // notify on run errors, default true
  notifTaskbar: boolean; // taskbar badge + flash, default true
  notifToastFocused: boolean; // in-app toast when focused, default true
}

const SETTINGS_KEY = 'barang:settings-v1';

const SETTING_DEFAULTS: BarangSettings = {
  model: null,
  modelChosen: false,
  agent: null,
  freeOnly: true,
  showReasoning: false,
  showActivity: false,
  confirmDelete: true,
  fontSize: 13,
  minimap: false,
  wordWrap: true,
  termShell: '',
  termFont: 12,
  termScrollback: 1000,
  termBlink: true,
  notifEnabled: true,
  notifNative: true,
  notifSound: true,
  notifSoundName: 'chime',
  notifCustomName: '',
  notifCustomPath: '',
  notifVolume: 80,
  notifOnDone: true,
  notifOnApproval: true,
  notifOnError: true,
  notifTaskbar: true,
  notifToastFocused: true,
};

export function readSettings(): BarangSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...SETTING_DEFAULTS };
    const p = JSON.parse(raw);
    return {
      ...SETTING_DEFAULTS,
      freeOnly: p.freeOnly !== false,
      showReasoning: p.showReasoning === true,
      showActivity: p.showActivity === true,
      confirmDelete: p.confirmDelete !== false,
      fontSize: Number.isFinite(p.fontSize) ? Math.max(11, Math.min(20, p.fontSize)) : SETTING_DEFAULTS.fontSize,
      minimap: p.minimap === true,
      wordWrap: p.wordWrap !== false,
      termShell: typeof p.termShell === 'string' ? p.termShell.slice(0, 500) : '',
      termFont: Number.isFinite(p.termFont) ? Math.max(10, Math.min(24, p.termFont)) : SETTING_DEFAULTS.termFont,
      termScrollback: [1000, 5000, 10000].includes(p.termScrollback) ? p.termScrollback : SETTING_DEFAULTS.termScrollback,
      termBlink: p.termBlink !== false,
      notifEnabled: p.notifEnabled !== false,
      notifNative: p.notifNative !== false,
      notifSound: p.notifSound !== false,
      notifSoundName: typeof p.notifSoundName === 'string' && p.notifSoundName ? p.notifSoundName.slice(0, 120) : 'chime',
      notifCustomName: typeof p.notifCustomName === 'string' ? p.notifCustomName.slice(0, 120) : '',
      notifCustomPath: typeof p.notifCustomPath === 'string' ? p.notifCustomPath.slice(0, 2000) : '',
      notifVolume: Number.isFinite(p.notifVolume) ? Math.max(0, Math.min(100, p.notifVolume)) : SETTING_DEFAULTS.notifVolume,
      notifOnDone: p.notifOnDone !== false,
      notifOnApproval: p.notifOnApproval !== false,
      notifOnError: p.notifOnError !== false,
      notifTaskbar: p.notifTaskbar !== false,
      notifToastFocused: p.notifToastFocused !== false,
      model: p.model?.providerID && p.model?.modelID ? { providerID: p.model.providerID, modelID: p.model.modelID } : null,
      modelChosen: p.modelChosen === true || !!(p.model?.providerID && p.model?.modelID),
      agent: typeof p.agent === 'string' ? p.agent : null,
    };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

export function writeSettings(s: BarangSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* private mode etc. */ }
}

/** Heuristic free-tier detection (opencode exposes no pricing flags).
 *  Matches :free / -free / "free" tokens and Muse Spark (free family). */
export function isFreeModel(providerID: string, modelID: string): boolean {
  return /free|muse-spark/i.test(`${providerID}/${modelID}`);
}

/** Default model chain: Muse Spark free family first, then MiMo free
 *  family (opencode provider preferred for both), else auto (null).
 *  Only free models are ever auto-picked — paid models need an explicit pick.
 *  Family regexes (not pinned versions) so 1.3 -> 1.4 renames keep working. */
export function pickDefaultModel(models: Array<{ providerID: string; modelID: string }>): { providerID: string; modelID: string } | null {
  const pool = models.filter((m) => isFreeModel(m.providerID, m.modelID));
  const inProv = (re: RegExp) =>
    pool.find((m) => m.providerID === 'opencode' && re.test(m.modelID)) ??
    pool.find((m) => re.test(`${m.providerID}/${m.modelID}`));
  const pick = inProv(/muse-spark/i) ?? inProv(/mimo/i);
  return pick ? { providerID: pick.providerID, modelID: pick.modelID } : null;
}

export async function loadMeta() {
  const [agentsRes, providersRes] = await Promise.all([
    oc.get<{ value?: AgentInfo[] } | AgentInfo[]>('/agent').catch(() => ({ value: [] })),
    oc.get<{ providers?: ProviderInfo[] } | { all?: ProviderInfo[] }>('/config/providers').catch(() => ({})),
  ]);
  const agents = Array.isArray(agentsRes) ? agentsRes : (agentsRes.value ?? []);
  const raw: ProviderInfo[] =
    (providersRes as { providers?: ProviderInfo[] }).providers ??
    (providersRes as { all?: ProviderInfo[] }).all ?? [];
  const providerModels: AgentState['providerModels'] = [];
  for (const p of raw) {
    const models = p.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const id = typeof m === 'string' ? m : (m.id ?? '');
        if (id) providerModels.push({ providerID: p.id, modelID: id, label: `${p.id}/${id}` });
      }
    } else if (models && typeof models === 'object') {
      for (const id of Object.keys(models)) providerModels.push({ providerID: p.id, modelID: id, label: `${p.id}/${id}` });
    }
  }
  providerModels.sort((a, b) => a.label.localeCompare(b.label));
  const s = agentStore.get();
  const saved = readSettings();
  const agent = saved.agent && agents.some((a) => a.name === saved.agent)
    ? saved.agent
    : agents.some((a) => a.name === s.agent) ? s.agent : (agents[0]?.name ?? 'build');
  let model = s.model;
  const savedInList = !!saved.model && providerModels.some((p) => p.providerID === saved.model!.providerID && p.modelID === saved.model!.modelID);
  if (!model && savedInList) {
    model = saved.model;
  }
  // Free default chain (spark -> mimo -> auto), but never over an explicit
  // pick — including an explicit Auto (modelChosen). A vanished pick falls
  // back to the chain rather than stranding on Auto.
  if (!model && (!saved.modelChosen || !savedInList)) model = pickDefaultModel(providerModels);
  agentStore.set({ agents, providerModels, agent, model });
}

/** Normalize a project path for comparison (Windows-safe). */
function normDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export async function loadSessions() {
  const list = await oc.get<SessionInfo[] | { value?: SessionInfo[] }>('/session').catch(() => []);
  const all = Array.isArray(list) ? list : (list.value ?? []);
  // Scope chat history to the open project: opencode sessions carry the
  // project root in `directory`. No project open = no sessions shown.
  const root = normDir(agentStore.get().root || '');
  const sessions = (root ? all.filter((x) => normDir(String(x.directory || '')) === root) : []).slice();
  sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  const s = agentStore.get();
  const activeId = s.activeId && sessions.some((x) => x.id === s.activeId) ? s.activeId : (sessions[0]?.id ?? null);
  agentStore.set({ sessions, activeId });
  if (activeId && activeId !== s.activeId) await refreshActive();
  else if (activeId) await refreshStatus(activeId);
}

/** First-run UX decision (pure, smoke-tested): with a project open and the
 *  agent online but zero sessions, boot straight into a fresh session
 *  instead of stranding the user on an empty skeletal panel. */
export function shouldAutoCreateSession(root: string, opencodeOk: boolean, sessionCount: number, creating: boolean): boolean {
  return root !== '' && opencodeOk && sessionCount === 0 && !creating;
}

export async function createSession(title?: string): Promise<string> {
  const created = await oc.post<SessionInfo>('/session', title ? { title } : {});
  await loadSessions();
  agentStore.set({ activeId: created.id, messages: [], permissions: [], busy: false, error: null });
  await refreshActive();
  return created.id;
}

export async function selectSession(id: string) {
  agentStore.set({ activeId: id, messages: [], permissions: [], busy: false, error: null });
  await refreshActive();
}

export async function deleteSession(id: string) {
  await oc.del(`/session/${id}`);
  const s = agentStore.get();
  const rest = s.sessions.filter((x) => x.id !== id);
  agentStore.set({
    sessions: rest,
    activeId: s.activeId === id ? (rest[0]?.id ?? null) : s.activeId,
    messages: s.activeId === id ? [] : s.messages,
  });
  if (agentStore.get().activeId) await refreshActive();
}

export async function refreshStatus(sessionId: string) {
  try {
    const st = await oc.get<Record<string, { type?: string }>>('/session/status');
    // Switched mid-flight — a stale session's busy flag must not leak in.
    if (agentStore.get().activeId !== sessionId) return;
    const cur = st?.[sessionId];
    agentStore.set({ busy: !!cur && cur.type !== 'idle', status: cur?.type ?? (agentStore.get().busy ? 'busy' : 'idle') });
  } catch { /* non-fatal */ }
}

export async function refreshActive() {
  const s = agentStore.get();
  if (!s.activeId) return;
  const id = s.activeId;
  const [msgs, _st] = await Promise.all([
    oc.get<ChatMessage[] | { value?: ChatMessage[] }>(`/session/${id}/message?limit=200`).catch(() => []),
    refreshStatus(id),
  ]);
  // Switched projects/sessions mid-flight — discard stale results instead of
  // painting another session's messages into the current view.
  if (agentStore.get().activeId !== id) return;
  const messages = Array.isArray(msgs) ? msgs : [];
  agentStore.set({ messages, permissions: extractPermissions(id, messages), error: null });
}

/** Best-effort permission-request extractor across opencode part schemas. */
function extractPermissions(sessionID: string, messages: ChatMessage[]): PendingPermission[] {
  const out: PendingPermission[] = [];
  const push = (permissionID: string, title: string, detail?: string) => {
    if (!permissionID || out.some((p) => p.permissionID === permissionID)) return;
    out.push({ key: `${sessionID}:${permissionID}`, sessionID, permissionID, title, detail });
  };
  const scan = (node: unknown, trail: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) scan(v, trail);
      return;
    }
    const o = node as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
    // Shape A: dedicated permission part { type:'permission…', permission:{id,…}, state:'pending' }
    if (type.includes('permission')) {
      const p = (o.permission ?? o) as Record<string, unknown>;
      const id = String(p.id ?? o.id ?? o.permissionID ?? '');
      const state = String(o.state ?? p.state ?? 'pending').toLowerCase();
      if (id && (state === 'pending' || state === 'waiting' || state === 'asked')) {
        push(id, String(p.title ?? o.title ?? 'Permission requested'), typeof p.detail === 'string' ? p.detail : typeof o.detail === 'string' ? o.detail : trail);
      }
    }
    // Shape B: tool-call awaiting approval { status:'awaiting_approval'|'needs_approval', callID/id }
    const status = typeof o.status === 'string' ? o.status.toLowerCase() : '';
    if (status.includes('approv') || status.includes('permission')) {
      const id = String(o.callID ?? o.callId ?? o.id ?? '');
      if (id) push(id, `Approve ${String(o.tool ?? o.name ?? 'tool')}`, trail);
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'parent') continue;
      scan(v, trail);
    }
  };
  for (const m of messages) scan(m.parts ?? [], m.info?.role === 'user' ? 'user' : 'assistant');
  return out;
}

export async function respondPermission(p: PendingPermission, allow: boolean, remember = false) {
  await oc.post(`/session/${p.sessionID}/permissions/${p.permissionID}`, {
    response: allow ? 'allow' : 'deny',
    remember,
  });
  await refreshActive();
}

export interface OutgoingFile {
  mime: string;
  filename: string;
  url: string; // data: URL for images
}

export async function sendMessage(text: string, files: OutgoingFile[] = []) {
  const s = agentStore.get();
  const body = text.trim();
  if (!body && !files.length) return;
  let id = s.activeId;
  if (!id) id = await createSession(body.slice(0, 48) || 'Image');
  agentStore.set({ busy: true, status: 'busy', error: null });
  try {
    await oc.post(`/session/${id}/message`, {
      ...(s.model ? { model: { providerID: s.model.providerID, modelID: s.model.modelID } } : {}),
      ...(s.agent ? { agent: s.agent } : {}),
      parts: [
        ...files.map((f) => ({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })),
        ...(body ? [{ type: 'text', text: body }] : []),
      ],
    });
  } catch (e) {
    agentStore.set({ error: (e as Error).message, busy: false, status: 'error' });
    return;
  }
  await refreshActive();
  await loadSessions().catch(() => {});
}

export async function abortActive() {
  const s = agentStore.get();
  if (!s.activeId) return;
  await oc.post(`/session/${s.activeId}/abort`).catch(() => {});
  await refreshActive();
}

/** Revert a message (and the file changes that came with it), like opencode. */
export async function revertMessage(sessionId: string, messageId: string) {
  await oc.post(`/session/${sessionId}/revert`, { messageID: messageId });
  await refreshActive();
}

/** Restore messages hidden by the last revert. */
export async function unrevertSession(sessionId: string) {
  await oc.post(`/session/${sessionId}/unrevert`);
  await refreshActive();
}

/** One file the session created/modified, derived from tool parts.
 *  NOTE: opencode's /session/:id/diff endpoint is systemically empty here
 *  (summary_* never populates), so Changes are derived from edit/write
 *  tool-call metadata instead — the same data the chat rows render. */
export interface ChangeEntry {
  file: string; // absolute path as reported by the tool
  rel: string; // root-relative when under the project, else as-reported
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  patch: string | null; // unified diff (edit tool) — null for whole-file writes
  kind: 'edit' | 'write';
}

export function deriveSessionChanges(messages: ChatMessage[], root: string): ChangeEntry[] {
  const byFile = new Map<string, ChangeEntry>();
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const r = normDir(root || '');
  const relOf = (abs: string) => {
    const fwd = abs.replace(/\\/g, '/');
    return r && norm(abs).startsWith(r + '/') ? fwd.slice(r.length + 1) : fwd;
  };
  for (const m of messages ?? []) {
    for (const p of m.parts ?? []) {
      const part = p as unknown as Record<string, unknown>;
      if (!part || typeof part !== 'object' || part.type !== 'tool') continue;
      const tool = String(part.tool ?? '');
      const state = part.state as Record<string, unknown> | undefined;
      const meta = state?.metadata as Record<string, unknown> | undefined;
      const fd = meta?.filediff as Record<string, unknown> | undefined;
      if (fd && typeof fd.file === 'string' && fd.file) {
        const file = fd.file;
        const patch = typeof fd.patch === 'string' ? fd.patch : typeof meta?.diff === 'string' ? (meta.diff as string) : null;
        byFile.set(norm(file), {
          file,
          rel: relOf(file),
          status: Number(fd.deletions) > 0 ? 'modified' : 'added',
          additions: Number(fd.additions) || 0,
          deletions: Number(fd.deletions) || 0,
          patch,
          kind: 'edit',
        });
      } else if (tool === 'write') {
        const input = state?.input as Record<string, unknown> | undefined;
        const fp = input?.filePath ?? input?.path ?? input?.file;
        if (typeof fp === 'string' && fp) {
          byFile.set(norm(fp), {
            file: fp, rel: relOf(fp), status: 'added',
            additions: 0, deletions: 0, patch: null, kind: 'write',
          });
        }
      }
    }
  }
  return [...byFile.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

export function setModel(providerID: string, modelID: string) {
  agentStore.set({ model: { providerID, modelID } });
}
export function setAgent(name: string) {
  agentStore.set({ agent: name });
}

export interface SelectableModel {
  providerID: string;
  modelID: string;
  label: string;
}

/** Model list honoring the free-only setting (shared by Settings + composer). */
export function listSelectableModels(): SelectableModel[] {
  const { providerModels } = agentStore.get();
  const { freeOnly } = readSettings();
  return freeOnly ? providerModels.filter((m) => isFreeModel(m.providerID, m.modelID)) : providerModels;
}

/** Apply a model dropdown value ('' = auto): persists + updates the store.
 *  Any explicit pick (including Auto) marks the model chosen, so boot-time
 *  free defaults never yank it away on reconnect. */
export function applyModelSelection(value: string) {
  const settings = readSettings();
  settings.modelChosen = true;
  if (!value) {
    settings.model = null;
    writeSettings(settings);
    agentStore.set({ model: null }); // Auto: opencode decides per task.
    return;
  }
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/');
  settings.model = { providerID, modelID };
  writeSettings(settings);
  setModel(providerID, modelID);
}
