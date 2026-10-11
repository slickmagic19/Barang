// MCP server management: pure config logic (unit-probed in smoke).
// Persistence goes through main's mcp:config IPC (raw bytes + backup);
// live status through GET /mcp; live connect through POST /mcp.
import { parseJsonc } from './util';

export type McpScope = 'managed' | 'project';
export type McpServerType = 'remote' | 'local';

export interface McpServerConfig {
  name: string;
  type: McpServerType;
  url?: string;
  command?: string[];
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: boolean; // remote only; false = Bearer/token mode
  enabled?: boolean; // false = disabled (omit/true = on)
}

export interface McpLive {
  status: string;
  error?: string;
}

export type McpRowStatus = 'connected' | 'failed' | 'needs-auth' | 'disabled' | 'needs-restart' | 'unknown';

export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Parse a config file (JSON or JSONC) into {config, mcp}. Never throws
 *  on shape — unparseable TEXT throws (refuse to wipe). Pure. */
export function parseMcpFile(text: string): { config: Record<string, unknown>; mcp: Record<string, unknown> } {
  const raw = String(text ?? '').trim();
  if (!raw) return { config: {}, mcp: {} };
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    throw new Error('existing config is not valid JSON/JSONC — fix it by hand first (a backup was NOT written)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('existing config is not a JSON object');
  }
  const config = parsed as Record<string, unknown>;
  const mcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
    ? (config.mcp as Record<string, unknown>)
    : {};
  return { config, mcp };
}

/** Normalize one raw mcp entry. Null when not an object. Pure. */
export function toServerConfig(name: string, raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const cmd = Array.isArray(o.command) ? o.command.map(String).filter(Boolean) : undefined;
  return {
    name,
    type: o.type === 'local' ? 'local' : 'remote',
    url: typeof o.url === 'string' ? o.url : undefined,
    command: cmd,
    environment: strMap(o.environment),
    headers: strMap(o.headers),
    oauth: typeof o.oauth === 'boolean' ? o.oauth : undefined,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
  };
}

/** Whole mcp section -> server list (insertion order). Pure. */
export function toServerList(mcp: Record<string, unknown>): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(mcp ?? {})) {
    const s = toServerConfig(name, raw);
    if (s) out.push(s);
  }
  return out;
}

/** Build full file text with the mcp section replaced (others preserved).
 *  Throws on unparseable existing text (never wipe blind). Pure. */
export function buildFileText(existingText: string, mcp: Record<string, unknown>): string {
  const { config } = parseMcpFile(existingText);
  const next: Record<string, unknown> = { ...config };
  if (!next.$schema) next.$schema = 'https://opencode.ai/config.json';
  next.mcp = mcp;
  return JSON.stringify(next, null, 2) + '\n';
}

/** Validate a server for saving. Returns error strings (empty = ok). Pure. */
export function validateServer(s: McpServerConfig): string[] {
  const errs: string[] = [];
  if (!MCP_NAME_RE.test(s.name || '')) errs.push('Name: letters, numbers, dash, underscore.');
  if (s.type === 'remote') {
    if (!/^https?:\/\/.+/i.test(s.url || '')) errs.push('URL must start with http(s)://.');
  } else if (s.type === 'local') {
    if (!s.command || !s.command.length) errs.push('Command must have at least the program.');
  } else {
    errs.push('Type must be remote or local.');
  }
  return errs;
}

/** Parse `Name: value` (headers) or `KEY=value` (env) textarea lines. Pure. */
export function parseKvLines(text: string, sep: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(sep);
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Server payload for POST /mcp (drops UI-only empties). Pure. */
export function toLiveConfig(s: McpServerConfig): Record<string, unknown> {
  const o: Record<string, unknown> = { type: s.type };
  if (s.type === 'remote') {
    if (s.url) o.url = s.url;
    if (s.headers && Object.keys(s.headers).length) o.headers = s.headers;
    if (typeof s.oauth === 'boolean') o.oauth = s.oauth;
  } else {
    if (s.command?.length) o.command = s.command;
    if (s.environment && Object.keys(s.environment).length) o.environment = s.environment;
  }
  if (typeof s.enabled === 'boolean') o.enabled = s.enabled;
  return o;
}

/** Normalize a pasted site URL into the plugin's fixed MCP endpoint. Pure. */
export function wordpressEndpoint(input: string): string {
  let u = String(input ?? '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  if (!/\/wp-json\//i.test(u)) u = `${u}/wp-json/easy-mcp-ai/v1/mcp`;
  return u;
}

/** WordPress (Easy MCP AI) quick-fill: Bearer-token mode, OAuth when no
 *  token is given. Pure. */
export function wordpressQuickFill(siteUrl: string, token: string): McpServerConfig {
  const url = wordpressEndpoint(siteUrl);
  const headers: Record<string, string> = {};
  const clean = token.trim();
  if (clean) headers.Authorization = `Bearer ${clean}`;
  return { name: 'wordpress', type: 'remote', url, headers, oauth: clean ? false : true, enabled: true };
}

/** Merge configured rows with live statuses (+ count of live servers from
 *  other config layers, so foreign servers don't confuse). Pure. */
export function mergeStatuses(
  configured: McpServerConfig[],
  live: Record<string, McpLive>,
): { rows: Array<{ server: McpServerConfig; live?: McpLive; effective: McpRowStatus; note?: string }>; foreign: number } {
  const rows = (configured ?? []).map((server) => {
    const lv = live?.[server.name];
    if (lv && typeof lv.status === 'string') {
      const st = lv.status.toLowerCase();
      if (st === 'connected') return { server, live: lv, effective: 'connected' as McpRowStatus };
      if (st.includes('auth')) {
        return {
          server, live: lv, effective: 'needs-auth' as McpRowStatus,
          note: 'Needs OAuth — Bearer token mode avoids this, or approve once in the opencode TUI.',
        };
      }
      if (st === 'failed' || st === 'error') {
        return { server, live: lv, effective: 'failed' as McpRowStatus, note: lv.error || 'Connection failed.' };
      }
      return { server, live: lv, effective: 'unknown' as McpRowStatus, note: `Server reports: ${lv.status}.` };
    }
    if (server.enabled === false) {
      return { server, effective: 'disabled' as McpRowStatus, note: 'Disabled in config.' };
    }
    return { server, effective: 'needs-restart' as McpRowStatus, note: 'Saved — restart the agent server to apply.' };
  });
  const known = new Set((configured ?? []).map((s) => s.name));
  const foreign = Object.keys(live ?? {}).filter((k) => !known.has(k)).length;
  return { rows, foreign };
}
