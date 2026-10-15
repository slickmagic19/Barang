// Custom (OpenAI-compatible) providers for the model picker: pure config
// logic over Barang's managed config file. Persistence goes through main's
// mcp:config IPC (raw bytes + backup); models surface via /config/providers
// after an agent-server restart. Dependency-light (only parseJsonc) so it
// can be unit-tested outside the renderer.
import { parseJsonc } from './util';

export interface CustomProviderEntry {
  id: string;
  baseURL: string;
  /** '' = none (e.g. local servers); 'env:NAME' = env reference; else value. */
  apiKey: string;
  models: string[];
}

export interface ProviderListItem {
  id: string;
  baseURL: string;
  keyKind: 'env' | 'value' | 'none';
  models: string[];
}

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const BASE_URL_RE = /^https?:\/\/\S{1,500}$/i;
const MODEL_ID_RE = /^[^\s"']{1,120}$/;
const ENV_REF_RE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/** Validate a provider form. Returns error strings (empty = ok). Pure. */
export function validateProviderEntry(e: CustomProviderEntry): string[] {
  const errs: string[] = [];
  if (!PROVIDER_ID_RE.test(String(e?.id ?? '').trim())) {
    errs.push('ID: lowercase letters, numbers, dashes (e.g. my-llm).');
  }
  if (!BASE_URL_RE.test(String(e?.baseURL ?? '').trim())) {
    errs.push('Base URL must start with http(s):// (the OpenAI-compatible endpoint).');
  }
  const key = String(e?.apiKey ?? '').trim();
  if (key && !ENV_REF_RE.test(key) && key.length > 500) {
    errs.push('API key is too long.');
  }
  const models = (e?.models ?? []).map((m) => String(m ?? '').trim()).filter(Boolean);
  if (!models.length) errs.push('List at least one model ID.');
  for (const m of models.slice(0, 50)) {
    if (!MODEL_ID_RE.test(m)) {
      errs.push(`Bad model ID: ${m.slice(0, 60)}`);
      break;
    }
  }
  return errs;
}

/** Split a models textarea/box into IDs (commas/newlines). Pure. */
export function parseModelIds(text: string): string[] {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Normalize the key field: 'env:NAME' -> {env:NAME} template, value -> raw
 *  (opencode stores provider keys as-is; the UI warns it is plaintext). */
export function normalizeProviderKey(key: string): string {
  const k = String(key ?? '').trim();
  const m = ENV_REF_RE.exec(k);
  return m ? `{env:${m[1]}}` : k;
}

/** Live config payload for one provider (OpenAI-compatible). Pure. */
export function providerToLiveConfig(e: CustomProviderEntry): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const m of parseModelIds(e.models.join(','))) models[m] = { name: m };
  const options: Record<string, unknown> = { baseURL: String(e.baseURL ?? '').trim() };
  const key = String(e.apiKey ?? '').trim();
  if (key) options.apiKey = normalizeProviderKey(key);
  return { npm: '@ai-sdk/openai-compatible', options, models };
}

function parseProvidersFile(fileText: string): { config: Record<string, unknown>; providers: Record<string, unknown> } {
  const raw = String(fileText ?? '').trim();
  if (!raw) return { config: {}, providers: {} };
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
  const providers = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? (config.providers as Record<string, unknown>)
    : {};
  return { config, providers };
}

/** Set (add/replace) one provider, preserving every other key. Throws on
 *  unparseable input (never wipe blind). Pure. */
export function setProviderEntry(fileText: string, entry: CustomProviderEntry): string {
  const errs = validateProviderEntry(entry);
  if (errs.length) throw new Error(errs[0]);
  const { config, providers } = parseProvidersFile(fileText);
  const next: Record<string, unknown> = { ...config };
  if (!next.$schema) next.$schema = 'https://opencode.ai/config.json';
  next.providers = { ...providers, [entry.id.trim()]: providerToLiveConfig(entry) };
  return JSON.stringify(next, null, 2) + '\n';
}

/** Remove one provider (no-op when absent). Throws on unparseable input. Pure. */
export function removeProviderEntry(fileText: string, id: string): string {
  const { config, providers } = parseProvidersFile(fileText);
  const next: Record<string, unknown> = { ...config };
  const rest = { ...providers };
  delete rest[String(id ?? '').trim()];
  next.providers = rest;
  return JSON.stringify(next, null, 2) + '\n';
}

/** Best-effort list of providers in a config file (skips malformed). Pure. */
export function listProviderEntries(fileText: string): ProviderListItem[] {
  const out: ProviderListItem[] = [];
  let providers: Record<string, unknown>;
  try {
    providers = parseProvidersFile(fileText).providers;
  } catch {
    return out;
  }
  for (const [id, raw] of Object.entries(providers ?? {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const opts = (o.options && typeof o.options === 'object' && !Array.isArray(o.options)
      ? (o.options as Record<string, unknown>)
      : {});
    const models = o.models && typeof o.models === 'object' && !Array.isArray(o.models)
      ? Object.keys(o.models as Record<string, unknown>)
      : [];
    const key = typeof opts.apiKey === 'string' ? opts.apiKey : '';
    out.push({
      id,
      baseURL: typeof opts.baseURL === 'string' ? opts.baseURL : '',
      keyKind: !key ? 'none' : ENV_REF_RE.test(key) || /^\{env:/.test(key) ? 'env' : 'value',
      models,
    });
  }
  return out;
}
