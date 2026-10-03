// Agent state: opencode sessions, streaming refresh via the /event SSE bus,
// generic part rendering + permission approvals. Keeps no secrets — the
// bridge injects server auth; model auth lives in the user's opencode CLI.
import { oc } from './api';
import { barang } from './transport';
import { createStore, debounce, timeAgo } from './util';

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
export interface SessionTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string; // project root the session belongs to (opencode-owned)
  time?: { created?: number; updated?: number };
  cost?: number; // dollars, server-reported (0 on free logins)
  tokens?: SessionTokens; // server-reported totals (exact, no 200-msg cap)
}

/** Compact token count (999 / 1.5K / 12.0M). Pure. */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}K`;
  if (v < 1000000) return `${Math.round(v / 1000)}K`;
  if (v < 100000000) return `${(v / 1000000).toFixed(1)}M`;
  return `${Math.round(v / 1000000)}M`;
}

export interface SessionUsage {
  tokens: number; // input + output + reasoning (cache shown in tooltip only)
  cost: number;
  label: string; // statusbar text: $ when billed, tokens otherwise
  title: string; // tooltip breakdown
}

/** Active-session usage for the statusbar meter. Null = nothing to show. Pure. */
export function sessionUsage(s?: SessionInfo | null): SessionUsage | null {
  if (!s) return null;
  const t = s.tokens ?? {};
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const input = num(t.input);
  const output = num(t.output);
  const reasoning = num(t.reasoning);
  const cacheRead = num(t.cache?.read);
  const cacheWrite = num(t.cache?.write);
  const cost = num((s as { cost?: unknown }).cost);
  const tokens = input + output + reasoning;
  if (!tokens && !cost) return null;
  const f = (n: number) => n.toLocaleString('en-US');
  const label = cost > 0 ? `$${cost >= 100 ? Math.round(cost) : cost.toFixed(2)}` : fmtTokens(tokens);
  const title = `Session usage — in ${f(input)} · out ${f(output)} · reasoning ${f(reasoning)} · cache ${f(cacheRead)}/${f(cacheWrite)} · $${cost.toFixed(4)}`;
  return { tokens, cost, label, title };
}

export interface UsageCard {
  title: string; // session title
  model: string; // provider/model label
  cost: string; // $0.00
  pct: number | null; // context used 0..100, null when limit unknown
  limit: number | null; // context window tokens
  tokens: string; // formatted total, e.g. 350,397
  input: string;
  output: string;
  reasoning: string;
  cache: string; // R/W
  messages: number;
  updated: string; // human age or '—'
}

/** Structured data for the usage hover card (Cost / Usage / Tokens +
 *  breakdown). Null = nothing to show. Pure. */
export function usageCard(
  s?: SessionInfo | null,
  modelLabel = 'auto model',
  messageCount = 0,
  contextLimit: number | null = null,
): UsageCard | null {
  const base = sessionUsage(s);
  if (!base) return null;
  const t = (s as SessionInfo)?.tokens ?? {};
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const f = (n: unknown) => num(n).toLocaleString('en-US');
  const limit = typeof contextLimit === 'number' && contextLimit > 0 ? Math.floor(contextLimit) : null;
  const pct = limit ? Math.min(100, Math.max(0, (base.tokens / limit) * 100)) : null;
  const upd = Number((s as SessionInfo)?.time?.updated ?? 0);
  return {
    title: String((s as SessionInfo)?.title || 'Untitled session'),
    model: modelLabel,
    cost: `$${base.cost.toFixed(2)}`,
    pct: pct === null ? null : Math.round(pct * 10) / 10,
    limit,
    tokens: f(base.tokens),
    input: f(t.input),
    output: f(t.output),
    reasoning: f(t.reasoning),
    cache: `${f(t.cache?.read)}/${f(t.cache?.write)}`,
    messages: Math.max(0, Math.floor(messageCount)),
    updated: upd > 0 ? timeAgo(upd) : '—',
  };
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
export type PermissionResponse = 'once' | 'always' | 'reject';

export interface PendingPermission {
  key: string;
  sessionID: string;
  permissionID: string;
  title: string;
  detail?: string;
  kind?: string; // tool family: bash, edit, external_directory…
  target?: string; // full rule target (path, pattern, command)
}

/** Middle-ellipsis for long paths (keeps both ends readable). Pure. */
export function shortenMiddle(text: string, max = 80): string {
  const t = String(text ?? '');
  if (t.length <= max || max < 10) return t;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

export type AttachRoute = 'image' | 'mention' | 'too-large' | 'skip';

/** Route a dropped/pasted/picked file: inline images go over as data,
 *  anything else becomes an @mention (needs a disk path). Pure. */
export function classifyAttachFile(name: string, size: number, maxBytes = 8 * 1024 * 1024): AttachRoute {
  if (!name) return 'skip';
  if (size > maxBytes) return 'too-large';
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? 'image' : 'mention';
}

export interface PendingQuestion {
  key: string;
  sessionID: string;
  questionID: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  messageID?: string;
  callID?: string;
}

export interface RunStatusInfo {
  type: 'idle' | 'busy' | 'retry';
  attempt?: number;
  message?: string;
  next?: number;
}

export interface AgentTodo {
  id: string;
  content: string;
  status: string; // pending | in_progress | completed | cancelled
  priority: string;
}

/** Done/total counts for the todo checklist header. Pure. */
export function todoProgress(todos: AgentTodo[]): { done: number; total: number; label: string } {
  const total = (todos ?? []).length;
  const done = (todos ?? []).filter((t) => String(t?.status ?? '').toLowerCase() === 'completed').length;
  return { done, total, label: total ? `${done} of ${total} todo${total === 1 ? '' : 's'} completed` : 'No todos' };
}

interface AgentState {
  root: string; // open project folder — sessions are scoped to it
  sessions: SessionInfo[];
  activeId: string | null;
  messages: ChatMessage[];
  todos: AgentTodo[];
  agents: AgentInfo[];
  providerModels: Array<{ providerID: string; modelID: string; label: string; limit?: number; variants?: string[] }>;
  model: { providerID: string; modelID: string } | null;
  agent: string;
  busy: boolean;
  status: string;
  statusInfo: RunStatusInfo | null; // raw server run state (carries retry attempt)
  permissions: PendingPermission[];
  questions: PendingQuestion[]; // agent question-tool waits (event-sourced)
  lastActivity: string; // human summary of what the run is doing (stall row)
  connected: boolean;
  error: string | null;
}

export const agentStore = createStore<AgentState>({
  root: '',
  sessions: [],
  activeId: null,
  messages: [],
  todos: [],
  agents: [],
  providerModels: [],
  model: null,
  agent: 'build',
  busy: false,
  status: 'idle',
  statusInfo: null,
  permissions: [],
  questions: [],
  lastActivity: '',
  connected: false,
  error: null,
});

const scheduleRefresh = debounce(() => void refreshActive().catch(() => {}), 300);
const scheduleSessions = debounce(() => void loadSessions().catch(() => {}), 800);

let eventsConnected = false;
let lastProgressAt = Date.now();
let stallTimer: ReturnType<typeof setInterval> | null = null;
/** Silence budget while a run is busy with zero updates (retry backoffs are
 *  expected-quiet and excluded by decideStalled). Pure threshold is exported. */
export const STALL_MS = 120000;

export function bumpProgress() {
  lastProgressAt = Date.now();
}

/** Stall decision (pure, smoke-tested): a busy non-retry run with no
 *  message/part/status/permission activity for STALL_MS is stuck — the
 *  server will never finish it on its own (e.g. an unanswered prompt the
 *  client failed to surface, or a wedged provider stream). */
export function decideStalled(lastProgress: number, now: number, busy: boolean, status: string): boolean {
  return busy && status !== 'retry' && now - lastProgress > STALL_MS;
}

export interface AgentEvent {
  type: string;
  props: Record<string, unknown>;
  directory: string;
}

/** Parse one upstream /event frame (GlobalEvent {directory, payload} or a
 *  bare {type, properties} object). Null when not JSON / not an event. Pure. */
export function parseAgentEvent(data: string): AgentEvent | null {
  try {
    const ev = JSON.parse(data) as { directory?: unknown; payload?: unknown; type?: unknown; properties?: unknown };
    const inner = (ev?.payload ?? ev) as { type?: unknown; properties?: unknown };
    if (!inner || typeof inner.type !== 'string') return null;
    const props = (inner.properties ?? {}) as Record<string, unknown>;
    if (!props || typeof props !== 'object') return null;
    return {
      type: inner.type,
      props,
      directory: typeof ev?.directory === 'string' ? ev.directory : '',
    };
  } catch {
    return null;
  }
}

/** Map a permission event payload to a prompt card. Handles the 1.18 shape
 *  {id, sessionID, permission, patterns, metadata{command}, always,
 *  tool{messageID, callID}} and newer {id, type, pattern(s), sessionID,
 *  messageID, callID, title, metadata, time} shapes. Null when unusable. Pure. */
export function permissionFromEvent(props: unknown): PendingPermission | null {
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : '';
  const sessionID = typeof p.sessionID === 'string' ? p.sessionID : '';
  if (!id || !sessionID) return null;
  const tool = (p.tool && typeof p.tool === 'object' ? p.tool : null) as Record<string, unknown> | null;
  const meta = (p.metadata && typeof p.metadata === 'object' ? p.metadata : null) as Record<string, unknown> | null;
  const patterns = Array.isArray(p.patterns) ? (p.patterns as unknown[]).map(String)
    : Array.isArray(p.pattern) ? (p.pattern as unknown[]).map(String)
    : typeof p.pattern === 'string' ? [p.pattern] : [];
  const name = typeof p.permission === 'string' && p.permission ? p.permission
    : typeof p.type === 'string' && p.type ? p.type : 'tool';
  const what = typeof p.title === 'string' && p.title ? p.title
    : patterns[0]
    ?? (typeof meta?.command === 'string' && meta.command ? meta.command : null)
    ?? (typeof meta?.path === 'string' && meta.path ? meta.path : null)
    ?? name;
  const title = what === name || what.startsWith(`${name}:`) || what.startsWith(`${name} `) ? what : `${name}: ${shortenMiddle(what, 90)}`;
  const always = Array.isArray(p.always) ? (p.always as unknown[]).map(String).filter(Boolean) : [];
  return {
    key: `${sessionID}:${id}`,
    sessionID,
    permissionID: id,
    title: title.slice(0, 300),
    detail: always.length ? `“Allow” remembers: ${always.join(', ')}`.slice(0, 300) : undefined,
    kind: name,
    target: what,
  };
}

/** Track a newly asked permission (dedupe by id). */
export function upsertPermission(props: unknown): PendingPermission | null {
  const card = permissionFromEvent(props);
  if (!card) return null;
  const cur = agentStore.get().permissions;
  if (cur.some((p) => p.key === card.key)) return cur.find((p) => p.key === card.key) ?? null;
  agentStore.set({ permissions: [...cur, card] });
  return card;
}

/** Drop a resolved permission (replied event). Returns true when removed. */
export function removePermission(sessionID: string, permissionID: string): boolean {
  const cur = agentStore.get().permissions;
  const next = cur.filter((p) => !(p.sessionID === sessionID && p.permissionID === permissionID));
  if (next.length === cur.length) return false;
  agentStore.set({ permissions: next });
  return true;
}

/** Map a question event payload to a card. 1.18 shape: {id, sessionID,
 *  questions:[{header, question, options:[{label, description}]}], tool}.
 *  Null when unusable. Pure. */
export function questionFromEvent(props: unknown): PendingQuestion | null {
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : '';
  const sessionID = typeof p.sessionID === 'string' ? p.sessionID : '';
  const qs = Array.isArray(p.questions) ? p.questions : [];
  if (!id || !sessionID || !qs.length) return null;
  const first = (qs[0] && typeof qs[0] === 'object' ? qs[0] : {}) as Record<string, unknown>;
  const tool = (p.tool && typeof p.tool === 'object' ? p.tool : null) as Record<string, unknown> | null;
  const options = Array.isArray(first.options)
    ? (first.options as unknown[]).filter((o) => o && typeof o === 'object').map((o) => {
      const oo = o as Record<string, unknown>;
      return { label: String(oo.label ?? ''), description: typeof oo.description === 'string' ? oo.description : undefined };
    }).filter((o) => o.label)
    : [];
  return {
    key: `${sessionID}:${id}`,
    sessionID,
    questionID: id,
    header: typeof first.header === 'string' ? first.header.slice(0, 120) : '',
    question: typeof first.question === 'string' ? first.question.slice(0, 500) : `${qs.length} question(s)`,
    options: options.slice(0, 8),
    messageID: tool && typeof tool.messageID === 'string' ? tool.messageID : undefined,
    callID: tool && typeof tool.callID === 'string' ? tool.callID : undefined,
  };
}

/** Track a newly asked question (dedupe by id). */
export function upsertQuestion(props: unknown): PendingQuestion | null {
  const card = questionFromEvent(props);
  if (!card) return null;
  const cur = agentStore.get().questions;
  if (cur.some((q) => q.key === card.key)) return cur.find((q) => q.key === card.key) ?? null;
  agentStore.set({ questions: [...cur, card] });
  return card;
}

/** Drop a resolved question (replied/rejected event). */
export function removeQuestion(sessionID: string, questionID: string): boolean {
  const cur = agentStore.get().questions;
  const next = cur.filter((q) => !(q.sessionID === sessionID && q.questionID === questionID));
  if (next.length === cur.length) return false;
  agentStore.set({ questions: next });
  return true;
}

/** Drop all of one session's questions (fresh send / confirmed stop: the
 *  wait belongs to a dead run). */
export function clearSessionQuestions(sessionID: string) {
  const cur = agentStore.get().questions;
  if (cur.some((q) => q.sessionID === sessionID)) {
    agentStore.set({ questions: cur.filter((q) => q.sessionID !== sessionID) });
  }
}

/** Reconcile with the server's live question list (GET /question covers
 *  waits from before this window subscribed — e.g. app restart). Prunes
 *  dead entries; never invents any. */
export async function backfillQuestions() {
  try {
    const list = await oc.get<unknown[]>('/question');
    if (!Array.isArray(list)) return;
    const cards = list.map(questionFromEvent).filter((c): c is PendingQuestion => !!c);
    const seen = new Set(cards.map((c) => c.key));
    const kept = agentStore.get().questions.filter((q) => seen.has(q.key));
    const fresh = cards.filter((c) => !kept.some((q) => q.key === c.key));
    if (fresh.length || kept.length !== agentStore.get().questions.length) {
      agentStore.set({ questions: [...kept, ...fresh] });
    }
  } catch { /* older server / offline — events still cover live waits */ }
}

/** One-line summary of what the run is doing (stall row + diagnosis).
 *  Waits the user can resolve come first. Pure. */
export function describeActivity(messages: ChatMessage[], permissions: PendingPermission[], questions: PendingQuestion[]): string {
  const q = (questions ?? [])[0];
  if (q) return `waiting for your answer: “${q.question.slice(0, 100)}”`;
  const p = (permissions ?? [])[0];
  if (p) return `waiting for your approval: ${p.title.slice(0, 100)}`;
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const parts = m?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as Record<string, unknown>;
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'question') return 'waiting for your answer (question tool)';
      if (part.type === 'tool') {
        const state = (part.state && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
        const st = String(state.status ?? part.status ?? '');
        if (st === 'completed' || st === 'error') continue;
        const tool = String(part.tool ?? part.name ?? 'tool');
        const title = typeof state.title === 'string' && state.title ? state.title : '';
        return `running ${tool}${title ? ` — ${title.slice(0, 80)}` : ''}`;
      }
    }
    if (String(m?.info?.role ?? '') === 'assistant') {
      const hasText = (m?.parts ?? []).some((x) => x?.type === 'text' && String(x?.text ?? '').trim());
      if (hasText) return 'writing a reply…';
      const hasReason = (m?.parts ?? []).some((x) => typeof x?.type === 'string' && /reason|think/i.test(x.type));
      if (hasReason) return 'reasoning…';
    }
  }
  return 'no output yet';
}

export function connectEvents() {
  if (eventsConnected) return;
  eventsConnected = true;
  // Upstream /event frames forwarded by the desktop main process.
  barang().events.onConn((c) => agentStore.set({ connected: c }));
  barang().events.subscribe((data: string) => {
    // Hot path (every streamed frame): match on the raw string. Parsing +
    // re-stringifying multi-MB frames here used to stall the UI.
    const blob = data.toLowerCase();
    const relevant =
      blob.includes('message') || blob.includes('session') ||
      blob.includes('part') || blob.includes('todo') || blob.includes('diff') ||
      blob.includes('permission') || blob.includes('question') || blob.includes('file.edited');
    if (!relevant) return;
    bumpProgress();
    // Permission lifecycle is event-sourced (permissions are NOT message
    // parts — scanning messages for them never found anything). Parse only
    // these small frames as JSON; the 1.18 server emits permission.asked,
    // newer ones permission.updated, both answered by permission.replied.
    if (blob.includes('permission')) {
      const ev = parseAgentEvent(data);
      if (ev) {
        const root = agentStore.get().root || '';
        const sameProject = !ev.directory || !root || normDir(ev.directory) === normDir(root);
        if (sameProject) {
          if (ev.type === 'permission.asked' || ev.type === 'permission.updated') {
            const card = upsertPermission(ev.props);
            if (card && readSettings().agentFullAuto) {
              // Full-permissions mode (TUI --auto): approve + remember, so
              // matching future asks stop appearing mid-run.
              void respondPermission(card, 'always').catch((e) => {
                agentStore.set({ error: `Auto-approve failed: ${(e as Error).message}` });
              });
            }
          } else if (ev.type === 'permission.replied') {
            const props = ev.props;
            const sid = typeof props.sessionID === 'string' ? props.sessionID : '';
            const pid = typeof props.permissionID === 'string' ? props.permissionID : '';
            if (sid && pid) removePermission(sid, pid);
          }
        }
      }
      scheduleRefresh();
      scheduleSessions();
      return;
    }
    // Agent question-tool waits: 1.18 has no HTTP reply route for them, so
    // the card is read-only (options shown, Stop + answer-in-chat recovery).
    if (blob.includes('question')) {
      const ev = parseAgentEvent(data);
      if (ev) {
        const root = agentStore.get().root || '';
        const sameProject = !ev.directory || !root || normDir(ev.directory) === normDir(root);
        if (sameProject) {
          if (ev.type === 'question.asked') upsertQuestion(ev.props);
          else if (ev.type === 'question.replied' || ev.type === 'question.rejected') {
            const props = ev.props;
            const sid = typeof props.sessionID === 'string' ? props.sessionID : '';
            const qid = typeof props.requestID === 'string' ? props.requestID : '';
            if (sid && qid) removeQuestion(sid, qid);
          }
        }
      }
      scheduleRefresh();
      scheduleSessions();
      return;
    }
    scheduleRefresh();
    scheduleSessions();
  });
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = setInterval(() => {
    const s = agentStore.get();
    if (decideStalled(lastProgressAt, Date.now(), s.busy, s.status)) {
      agentStore.set({ status: 'stalled' });
    }
  }, 15000);
  if (typeof (stallTimer as unknown as { unref?: unknown }).unref === 'function') {
    (stallTimer as unknown as { unref: () => void }).unref();
  }
}

export interface BarangSettings {
  model: { providerID: string; modelID: string } | null; // null = auto
  modelChosen: boolean; // explicit pick (even Auto) — boot defaults never override
  agent: string | null;
  agentFullAuto: boolean; // auto-approve permission asks (TUI --auto equivalent), default false
  effort: string | null; // reasoning variant for the active model, null = Default
  freeOnly: boolean;
  showUsage: boolean; // statusbar session cost meter, default true
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
  agentFullAuto: false,
  effort: null,
  freeOnly: true,
  showUsage: true,
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
      showUsage: p.showUsage !== false,
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
      agentFullAuto: p.agentFullAuto === true,
      effort: typeof p.effort === 'string' && p.effort ? p.effort.slice(0, 32) : null,
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
  const limitOf = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const lim = (m as { limit?: { context?: unknown } }).limit?.context;
    const n = Number(lim);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const variantsOf = (m: unknown): string[] | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const v = (m as { variants?: unknown }).variants;
    if (!v || typeof v !== 'object') return undefined;
    const keys = (Array.isArray(v) ? v.map(String) : Object.keys(v)).filter(Boolean).slice(0, 12);
    return keys.length ? keys : undefined;
  };
  for (const p of raw) {
    const models = p.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const id = typeof m === 'string' ? m : (m.id ?? '');
        if (id) providerModels.push({ providerID: p.id, modelID: id, label: `${p.id}/${id}`, limit: limitOf(m), variants: variantsOf(m) });
      }
    } else if (models && typeof models === 'object') {
      for (const [id, m] of Object.entries(models)) providerModels.push({ providerID: p.id, modelID: id, label: `${p.id}/${id}`, limit: limitOf(m), variants: variantsOf(m) });
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
  const { value: created } = await withSendRetries(() => oc.post<SessionInfo>('/session', title ? { title } : {}));
  await loadSessions();
  agentStore.set({ activeId: created.id, messages: [], todos: [], permissions: [], busy: false, error: null });
  await refreshActive();
  return created.id;
}

export async function selectSession(id: string) {
  agentStore.set({ activeId: id, messages: [], todos: [], permissions: [], busy: false, error: null });
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
    permissions: s.permissions.filter((p) => p.sessionID !== id),
    questions: s.questions.filter((q) => q.sessionID !== id),
  });
  if (agentStore.get().activeId) await refreshActive();
}

export async function refreshStatus(sessionId: string) {
  try {
    const st = await oc.get<Record<string, RunStatusInfo>>('/session/status');
    // Switched mid-flight — a stale session's busy flag must not leak in.
    if (agentStore.get().activeId !== sessionId) return;
    agentStore.set(decideStatus(st?.[sessionId], agentStore.get()));
  } catch { /* non-fatal */ }
}

/** Map a raw server status onto store state. Proven live: the server
 *  DELETES a session's entry when its run ends (no idle entries, ever) —
 *  so a missing entry means idle, not "keep previous". The only exception
 *  is the seconds right after our own submit, before the run publishes.
 *  Pure. */
export function decideStatus(
  cur: RunStatusInfo | null | undefined,
  prev: { busy: boolean; status: string; statusInfo: RunStatusInfo | null },
  nowMs = Date.now(),
  lastSubmitMs = lastSubmitAt,
): { busy: boolean; status: string; statusInfo: RunStatusInfo | null } {
  if (cur) {
    const t = cur.type ?? 'busy';
    return { busy: t !== 'idle', status: t, statusInfo: cur };
  }
  if (prev.busy && nowMs - lastSubmitMs < 5000) {
    return { busy: true, status: 'busy', statusInfo: { type: 'busy' } };
  }
  return { busy: false, status: 'idle', statusInfo: null };
}

let lastSubmitAt = 0;

/** Busy-row label: the server retries failed runs itself (status type
 *  'retry' + attempt) — surfacing it is what "retry like opencode" means.
 *  Back to 'Agent working…' the moment the run resumes. Pure. */
export function statusTextFor(status: string, attempt = 0): string {
  if (status === 'retry') return attempt > 0 ? `Agent retrying… (attempt ${attempt})` : 'Agent retrying…';
  if (status === 'stalled') return 'Agent stalled';
  if (status === 'stopping') return 'Agent stopping…';
  return `Agent working… (${status || 'busy'})`;
}

/** Human text for an assistant message's server-reported run error
 *  (info.error). Null when there is nothing to show — user-initiated
 *  aborts are normal, not errors. Pure. */
export function messageErrorText(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: string; data?: { message?: string; providerID?: string; statusCode?: number } };
  if (e.name === 'MessageAbortedError') return null;
  const d = e.data ?? {};
  const msg = typeof d.message === 'string' ? d.message : '';
  if (e.name === 'ProviderAuthError') {
    return `Provider sign-in error${d.providerID ? ` (${d.providerID})` : ''}: ${msg || 'reconnect the provider, then send again.'}`;
  }
  if (e.name === 'MessageOutputLengthError') {
    return 'The run hit the output length limit. Ask it to continue with a smaller scope.';
  }
  if (typeof d.statusCode === 'number') return `${msg || 'Provider request failed.'} (HTTP ${d.statusCode})`;
  return msg || null;
}

export async function refreshActive() {
  const s = agentStore.get();
  if (!s.activeId) return;
  const id = s.activeId;
  const [msgs, _st, todos] = await Promise.all([
    oc.get<ChatMessage[] | { value?: ChatMessage[] }>(`/session/${id}/message?limit=200`).catch(() => []),
    refreshStatus(id),
    oc.get<AgentTodo[]>(`/session/${id}/todo`).catch(() => []),
  ]);
  // Switched projects/sessions mid-flight — discard stale results instead of
  // painting another session's messages into the current view.
  if (agentStore.get().activeId !== id) return;
  const messages = Array.isArray(msgs) ? msgs : [];
  const todoList = Array.isArray(todos) ? todos : [];
  // Run errors live ON the assistant message (info.error) — rendered inline
  // by the chat list. The latest assistant message decides, so a new run
  // clears a previous failure instead of showing it forever.
  let runError: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (String(m?.info?.role ?? '').toLowerCase() !== 'assistant') continue;
    runError = messageErrorText(m?.info?.error);
    break;
  }
  // NOTE: permissions are event-sourced (permission.asked/updated), never
  // message parts — the old part-scanner found nothing and is gone.
  const st = agentStore.get();
  agentStore.set({
    messages,
    todos: todoList,
    error: runError,
    lastActivity: describeActivity(messages, st.permissions, st.questions),
  });
  if (messages.length !== s.messages.length) bumpProgress();
  if (st.busy) void backfillQuestions().catch(() => {});
}

export async function respondPermission(p: PendingPermission, response: PermissionResponse) {
  await oc.post(`/session/${p.sessionID}/permissions/${p.permissionID}`, { response });
  removePermission(p.sessionID, p.permissionID);
  await refreshActive();
}

export interface OutgoingFile {
  mime: string;
  filename: string;
  url: string; // data: URL for images
}

const SENDABLE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const SENDABLE_DATAURL = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_SEND_FILES = 8;
const MAX_SEND_FILE_CHARS = 12_000_000; // ~8MB attach cap (base64 inflates 4/3)

/** Drop malformed attachments before POST. A part with an empty/unknown
 *  mime or a non-data URL sails through our server proxy and dies at the
 *  model provider as "request contains invalid parameters" — a fatal,
 *  non-retryable 400. Pure. */
export function sanitizeOutgoingFiles(files: OutgoingFile[]): OutgoingFile[] {
  const out: OutgoingFile[] = [];
  for (const f of files ?? []) {
    if (out.length >= MAX_SEND_FILES) break;
    const mime = String(f?.mime ?? '').toLowerCase();
    const filename = String(f?.filename ?? '').slice(0, 200);
    const url = String(f?.url ?? '');
    if (!SENDABLE_IMAGE.test(mime) || !filename) continue;
    if (url.length > MAX_SEND_FILE_CHARS || !SENDABLE_DATAURL.test(url)) continue;
    out.push({ mime, filename, url });
  }
  return out;
}

export interface SendSelection {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

/** Resolve the reasoning variant to send: only when a model is selected
 *  AND it advertises that variant (a stale pick silently becomes Default).
 *  Verified live: top-level `variant` lands on the message model. Pure. */
export function resolveSendVariant(
  model: { providerID: string; modelID: string } | null,
  effort: string | null,
  catalog: Array<{ providerID: string; modelID: string; variants?: string[] }>,
): string | undefined {
  if (!model || !effort) return undefined;
  const entry = (catalog ?? []).find((m) => m.providerID === model.providerID && m.modelID === model.modelID);
  return entry?.variants?.includes(effort) ? effort : undefined;
}
/** Resolve what model/agent override to send. A stored model pick can go
 *  stale (free families rotate, e.g. muse-spark 1.3 -> 1.4) while the pick
 *  persists in settings — sending the dead ID makes the provider reject
 *  the request as invalid parameters. Falls back to the free chain, then
 *  auto. An unknown agent name is dropped the same way (server default).
 *  Empty catalog (meta not loaded yet) passes the request through. Pure. */
export function resolveSendModel(
  model: { providerID: string; modelID: string } | null,
  catalog: Array<{ providerID: string; modelID: string }>,
  agentNames: string[],
  agent: string,
): SendSelection {
  const sel: SendSelection = {};
  if (!catalog.length) {
    if (model) sel.model = model;
  } else if (model && catalog.some((m) => m.providerID === model.providerID && m.modelID === model.modelID)) {
    sel.model = model;
  } else {
    const d = pickDefaultModel(catalog);
    if (d) sel.model = d; // else auto: omit, opencode decides
  }
  if (agent && (agentNames.length === 0 || agentNames.includes(agent))) sel.agent = agent;
  return sel;
}

const SUBMIT_TIMEOUT_MS = 30000;

/** Transport-down signals (the request may never have reached the server).
 *  Anything else (HTTP errors included) means the server answered — and a
 *  failed prompt_async can still have stored the user message. Pure. */
export function isTransportDown(message: string): boolean {
  return /not running yet|failed to fetch|fetch failed|unreachable|load failed|econnrefused|enotfound|econnreset|socket|hang up|timeout/i.test(String(message ?? ''));
}

/** Locate our just-sent user message (server echoes the client messageID;
 *  fall back to recent matching text). Pure. */
export function findUserMessage(messages: ChatMessage[], messageID: string, body: string): boolean {
  for (const m of messages ?? []) {
    if (String(m?.info?.role ?? '').toLowerCase() !== 'user') continue;
    if (m?.info?.id === messageID) return true;
    if (body && m?.info?.id === undefined) continue;
    const text = (m?.parts ?? []).filter((p) => p?.type === 'text').map((p) => String(p?.text ?? '')).join('\n');
    const created = Number(m?.info?.time?.created ?? 0);
    if (text === body && created > 0 && Date.now() - created < 180000) return true;
  }
  return false;
}

export async function sendMessage(text: string, rawFiles: OutgoingFile[] = []): Promise<boolean> {
  const s = agentStore.get();
  const body = text.trim();
  const files = sanitizeOutgoingFiles(rawFiles);
  if (!body && !files.length) {
    // Everything attached was malformed — say so instead of sending a
    // part-less request the provider would reject as invalid parameters.
    if (rawFiles.length) agentStore.set({ error: 'Attachment unreadable (only PNG, JPG, GIF, WebP, BMP up to 8 MB). Re-attach and try again.', busy: false, status: 'idle', statusInfo: null });
    return false;
  }
  let id = s.activeId;
  if (!id) {
    try {
      id = await createSession(body.slice(0, 48) || 'Image');
    } catch {
      return false; // createSession surfaces its own state; composer restores
    }
  }
  const sel = resolveSendModel(s.model, s.providerModels, s.agents.map((a) => a.name), s.agent);
  const variant = resolveSendVariant(sel.model ?? null, readSettings().effort, s.providerModels);
  // Opencode-style submission: prompt_async returns 204 immediately and the
  // run streams over events — the composer never wedges on a blocking POST,
  // and run-level retries happen server-side (surfaced as 'Agent retrying').
  // The client messageID makes submit retries idempotent; a reconcile check
  // after any failure guarantees we never stack duplicate user messages.
  const messageID = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  agentStore.set({ busy: true, status: 'busy', statusInfo: { type: 'busy' }, error: null, lastActivity: 'sending…' });
  lastSubmitAt = Date.now();
  clearSessionQuestions(id); // a fresh run supersedes any dead waits
  bumpProgress();
  const payload = {
    messageID,
    ...(sel.model ? { model: { providerID: sel.model.providerID, modelID: sel.model.modelID } } : {}),
    ...(sel.agent ? { agent: sel.agent } : {}),
    ...(variant ? { variant } : {}),
    parts: [
      ...files.map((f) => ({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })),
      ...(body ? [{ type: 'text', text: body }] : []),
    ],
  };
  let sent = false;
  let lastErr = '';
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      await oc.post(`/session/${id}/prompt_async`, payload, { timeoutMs: SUBMIT_TIMEOUT_MS });
      sent = true;
    } catch (e) {
      lastErr = (e as Error)?.message ?? String(e);
      // The server may have stored the message before failing — check
      // before any retry instead of blindly re-POSTing a duplicate.
      await refreshActive().catch(() => {});
      if (findUserMessage(agentStore.get().messages, messageID, body)) {
        sent = true;
        break;
      }
      if (!isTransportDown(lastErr)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!sent) {
    agentStore.set({ error: lastErr || 'The message was not accepted. The agent may be down — retry in a moment.', busy: false, status: 'error', statusInfo: null });
    return false;
  }
  await loadSessions().catch(() => {});
  return true;
}

/**
 * Upstream-style submission retry (mirrors opencode session/retry.ts:
 * 5 retries, 2s initial, x2 backoff, 0.25 jitter, 30s cap). Only
 * transient failures retry (5xx/429/network/overload); fatal ones —
 * including provider 400s like "invalid parameters" — fail fast, because
 * each re-POST would append another duplicate user message. The
 * isMine gate lets abort (or a newer send) cancel pending waits instead
 * of lingering, and suppresses stale error states.
 */
export const SEND_MAX_RETRIES = 5;
const SEND_RETRY_INITIAL_MS = 2000;
const SEND_RETRY_FACTOR = 2;
const SEND_RETRY_JITTER = 0.25;
const SEND_RETRY_MAX_MS = 30000;

const ABORT_TIMEOUT_MS = 15000;

export async function abortActive() {
  const s = agentStore.get();
  if (!s.activeId) return;
  const id = s.activeId;
  // Optimistic stopping state: the button visibly does something even if the
  // server is wedged. Verified after (missing status entry = stopped).
  agentStore.set({ status: 'stopping', lastActivity: 'stopping the run…' });
  try {
    await oc.post(`/session/${id}/abort`, undefined, { timeoutMs: ABORT_TIMEOUT_MS });
  } catch { /* fall through to verify — the run may already be dead */ }
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (agentStore.get().activeId !== id) return; // switched away mid-stop
    await refreshStatus(id).catch(() => {});
    const cur = agentStore.get();
    if (cur.activeId !== id || !cur.busy) {
      clearSessionQuestions(id); // confirmed dead — its waits died with it
      await refreshActive().catch(() => {});
      return;
    }
    // Still going: hold the stopping state so the button state stays honest.
    agentStore.set({ status: 'stopping' });
  }
  // Still busy server-side: say so plainly instead of pretending.
  agentStore.set({
    status: 'busy',
    error: 'Stop did not take — the run is still going server-side. Switch projects (or restart Barang) to force-stop it.',
  });
}

const SEND_FATAL = [
  /\b(400|401|402|403|404|405|409|410|412|413|418|422|428)\b/, // deterministic client errors — resending changes nothing
  /invalid (parameter|request|argument|model|key|token)|validation (error|failed)|bad request|malformed|not (a )?valid|unsupported|not (supported|allowed)/i,
  /unauthorized|forbidden|access denied|invalid (api[-_ ]?key|token|auth)|authentication (failed|error)|permission denied/i,
  /not found|no such|unknown (model|agent|provider|session|file)|does not exist|model .* (retired|removed|deprecated|not available)/i,
  /insufficient (quota|funds|credits)|quota exceeded|billing|payment required|account (suspended|disabled)/i,
  /context (too long|length|exceeded)|too many tokens|token limit|message too (long|large)|maximum context/i,
  /\babort\w*|\bcancel\w*|superseded/i,
];

const SEND_RETRYABLE = [
  /\b(408|425|429|500|502|503|504|524)\b/,
  /rate limit|rate-limit|rate_limit|too many requests|overloaded|service unavailable|service_unavailable|internal error|internal_error|internal server error|server error|bad gateway|gateway timeout|temporar\w* unavailable/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]?error|connection error|connection refused|connection lost|connection reset|socket|hang up|reset before headers|getaddrinfo|enotfound|econnrefused|econnreset|etimedout/i,
  /timeout|timed out|time out|deadline exceeded/i,
  /try (?:your request )?again|please retry|resource exhausted/i,
  /not running yet|load failed/i, // our transport: server restarting / unreachable
];

/** True when a submission error is worth another attempt. Pure.
 *  Fatal (deterministic: 4xx, invalid params, auth, unknown model, quota
 *  exhaustion, context overflow) is checked FIRST — retrying those only
 *  stacks duplicate user messages, one per attempt. */
export function isRetryableSendError(message: string): boolean {
  const msg = String(message ?? '');
  if (!msg.trim()) return false;
  if (SEND_FATAL.some((re) => re.test(msg))) return false;
  return SEND_RETRYABLE.some((re) => re.test(msg));
}

/** Backoff for retry N (1-based): initial * 2^(N-1) ± 25%, capped. Pure. */
export function retryDelayMs(attempt: number, initialMs = SEND_RETRY_INITIAL_MS, maxMs = SEND_RETRY_MAX_MS): number {
  const exp = Math.min(initialMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = exp * SEND_RETRY_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  isMine?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (retry: number, maxRetries: number) => void;
}

/** Thrown (with .attempts + .code) when a newer send/abort supersedes. */
export function isSupersededError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'SUPERSEDED';
}

/**
 * Run fn with upstream-style retries. Resolves { value, attempts }; throws
 * the last error (with .attempts) when retries run out, or a SUPERSEDED
 * error when isMine() flips mid-flight.
 */
export async function withSendRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<{ value: T; attempts: number }> {
  const maxRetries = opts.maxRetries ?? SEND_MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const superseded = (attempts: number): Error => {
    const e = new Error('superseded') as Error & { code?: string; attempts?: number };
    e.code = 'SUPERSEDED';
    e.attempts = attempts;
    return e;
  };
  let attempts = 0;
  let lastErr: unknown = null;
  for (let retry = 0; ; retry++) {
    if (opts.isMine && !opts.isMine()) throw superseded(attempts);
    attempts++;
    try {
      const value = await fn();
      return { value, attempts };
    } catch (e) {
      lastErr = e;
      if (isSupersededError(e)) throw e;
      if (!isRetryableSendError((e as Error)?.message ?? String(e))) {
        (e as { attempts?: number }).attempts = attempts;
        throw e;
      }
      if (retry >= maxRetries) break;
      opts.onAttempt?.(retry + 1, maxRetries);
      const d = retryDelayMs(retry + 1, opts.initialDelayMs, opts.maxDelayMs);
      const end = Date.now() + d;
      let aborted = false;
      for (;;) {
        if (opts.isMine && !opts.isMine()) {
          aborted = true;
          break;
        }
        const left = end - Date.now();
        if (left <= 0) break;
        await sleep(Math.min(500, left));
      }
      if (aborted) throw superseded(attempts);
    }
  }
  const err = (lastErr as Error) ?? new Error('failed');
  (err as { attempts?: number }).attempts = attempts;
  throw err;
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
  limit?: number;
  variants?: string[];
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
