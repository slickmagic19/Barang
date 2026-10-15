// CLI Relay: route opencode-provider chats through the official `opencode run`
// CLI instead of the serve API (Zen free models are gated for serve-driven
// clients, but answer for the official CLI — verified live). This module is
// dependency-free and pure so it can be unit-tested outside the renderer:
// arg building (allowlisted, shell-free), JSON event parsing, progress
// labels, and secret redaction for anything surfaced in the UI.
export const RELAY_DISPLAY_NAME = 'CLI Relay';

/** Hard cap for one relayed run (long agentic runs need room; the Stop
 *  button + process exit normally end it much sooner). */
export const RELAY_MAX_MS = 15 * 60 * 1000;

/** Windows CreateProcess caps argv at 32767 chars — stay well under it and
 *  fail with a clear message instead of a cryptic spawn error. */
export const RELAY_MAX_ARGV_CHARS = 24000;

/** Max -f attachments per relayed send (mirrors the serve path cap). */
export const RELAY_MAX_FILES = 5;

export const RELAY_MAX_TITLE = 120;

export interface RelayModel {
  providerID: string;
  modelID: string;
}

/** True when this send must go through the CLI instead of serve: the relay
 *  setting is on and the resolved model is an opencode (Zen) model. Pure. */
export function shouldRelayRoute(model: RelayModel | null, relayEnabled: boolean): boolean {
  return !!relayEnabled && !!model && model.providerID === 'opencode';
}

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-+:]{0,199}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]{20,40}$/;

export interface RelayRequest {
  message: string;
  model: RelayModel;
  agent?: string;
  sessionID?: string;
  title?: string;
  variant?: string;
  /** Absolute host paths (main re-checks existence + confinement). */
  files?: string[];
  /** --auto: approve anything not explicitly denied (user-opted danger). */
  auto: boolean;
}

/** Build argv for `opencode run`. Main spawns it with shell:false, so there
 *  is no shell to inject into — validation here is defense in depth plus
 *  clear errors (bad agent/session names, argv budget). Throws. Pure. */
export function buildRelayArgs(req: RelayRequest): string[] {
  const message = String(req?.message ?? '');
  if (!message.trim()) throw new Error('CLI relay needs message text.');
  const providerID = String(req?.model?.providerID ?? '');
  const modelID = String(req?.model?.modelID ?? '');
  if (!PROVIDER_ID_RE.test(providerID)) throw new Error('Bad provider ID for CLI relay.');
  if (!MODEL_ID_RE.test(modelID)) throw new Error('Bad model ID for CLI relay.');
  const argv = ['run', message, '--format', 'json', '--model', `${providerID}/${modelID}`];
  const agent = String(req?.agent ?? '').trim();
  if (agent) {
    if (!AGENT_RE.test(agent)) throw new Error('Bad agent name for CLI relay.');
    argv.push('--agent', agent);
  }
  const sessionID = String(req?.sessionID ?? '').trim();
  if (sessionID) {
    if (!SESSION_ID_RE.test(sessionID)) throw new Error('Bad session ID for CLI relay.');
    argv.push('--session', sessionID);
  }
  const title = String(req?.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, RELAY_MAX_TITLE);
  if (title) argv.push('--title', title);
  const variant = String(req?.variant ?? '').trim();
  if (variant) {
    if (!AGENT_RE.test(variant) || variant.length > 32) throw new Error('Bad variant for CLI relay.');
    argv.push('--variant', variant);
  }
  const files = (req?.files ?? []).filter((f) => typeof f === 'string' && f);
  if (files.length > RELAY_MAX_FILES) throw new Error(`CLI relay takes at most ${RELAY_MAX_FILES} files.`);
  for (const f of files) {
    if (!/^[A-Za-z]:[\\/]/.test(f) && !f.startsWith('/') && !f.startsWith('\\\\')) {
      throw new Error('CLI relay files must be absolute paths.');
    }
    argv.push('--file', f);
  }
  if (req?.auto) argv.push('--auto');
  const total = argv.reduce((n, a) => n + a.length, 0);
  if (total > RELAY_MAX_ARGV_CHARS) {
    throw new Error('Message too long for CLI relay (>24KB of args) — shorten it or use another model.');
  }
  return argv;
}

export type RelayParsed =
  | {
    kind: 'event';
    type: string;
    sessionID?: string;
    text?: string;
    tool?: string;
    toolTitle?: string;
    toolStatus?: string;
    finishReason?: string;
  }
  | { kind: 'unknown' };

/** Parse one `--format json` stdout line (step_start/text/tool_use/
 *  step_finish …). Unknown lines/shapes -> unknown (never throws). Pure. */
export function parseRelayLine(line: string): RelayParsed {
  let o: unknown;
  try {
    o = JSON.parse(String(line ?? ''));
  } catch {
    return { kind: 'unknown' };
  }
  if (!o || typeof o !== 'object' || typeof (o as { type?: unknown }).type !== 'string') {
    return { kind: 'unknown' };
  }
  const obj = o as Record<string, unknown>;
  const part = (obj.part && typeof obj.part === 'object' ? obj.part : {}) as Record<string, unknown>;
  const state = (part.state && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
  const out: RelayParsed = { kind: 'event', type: obj.type as string };
  if (typeof obj.sessionID === 'string') out.sessionID = obj.sessionID;
  if (typeof part.text === 'string') out.text = part.text;
  if (typeof part.tool === 'string') out.tool = part.tool;
  if (typeof state.status === 'string') out.toolStatus = state.status;
  if (typeof state.title === 'string') out.toolTitle = state.title;
  else if (typeof part.title === 'string') out.toolTitle = part.title;
  if (typeof part.reason === 'string') out.finishReason = part.reason;
  return out;
}

/** One-line busy label for a relay event (tool calls only — text deltas
 *  would spam). Null = nothing worth showing. Pure. */
export function relayProgressLabel(ev: RelayParsed): string | null {
  if (ev.kind !== 'event' || ev.type !== 'tool_use' || !ev.tool) return null;
  const st = ev.toolStatus && ev.toolStatus !== 'pending' ? ` ${ev.toolStatus}` : '';
  const title = ev.toolTitle ? ` — ${ev.toolTitle.slice(0, 60)}` : '';
  return `tool ${ev.tool}${st}${title}`;
}

const SECRET_RES = [
  /\bsk-[A-Za-z0-9\-_]{8,}\b/g,
  /\bck_[A-Za-z0-9]{8,}\b/g,
  /\bwpmcp_[A-Za-z0-9]+\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g,
];

/** Mask API-key-shaped material before it reaches the UI. Pure. */
export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, '[redacted]');
  }
  return out;
}
