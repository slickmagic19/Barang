// Post-turn memory extraction: Qoder-style automatic memory updates.
//
// After each agent turn completes, a cheap background model call scans the
// last exchange for memory-worthy facts (user preferences, feedback, project
// constraints, references). Writes go through the existing memory IPC; when
// something changed the caller shows a "Memory Updated" badge in chat.
//
// Runs in a hidden child session (deleted immediately) so the user's
// transcript is never polluted. Everything is best-effort: any failure just
// leaves memory untouched.
import { oc } from './api';
import { barang } from './transport';
import { forgetHiddenSession, registerHiddenSession } from './hiddenSessions';
import {
  MEMORY_SLUG_RE,
  parseMemoryMarkdown,
  serializeMemory,
  upsertIndexLine,
  type MemoryScope,
  type MemoryType,
} from './memory';

/** Title marking our short-lived extraction sessions (filtered from the
 *  sidebar by loadSessions). */
export const EXTRACT_SESSION_TITLE = '__barang_memory_extract__';

export interface ExtractionMessage {
  info?: { id?: unknown; role?: unknown; error?: unknown; time?: { created?: unknown; completed?: unknown } };
  parts?: Array<{ type?: unknown; text?: unknown }>;
}

export interface MemoryExtractionInput {
  sessionId: string;
  messages: ExtractionMessage[];
  model: { providerID: string; modelID: string } | null;
}

export interface MemoryCandidate {
  slug: string;
  title: string;
  hook: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
}

export interface ExtractionResult {
  wrote: number;
}

const MAX_CANDIDATES = 3;
const MAX_TURN_CHARS = 6000;
const MIN_TURN_CHARS = 120;
const POLL_MS = 500;
const POLL_TRIES = 40; // ~20s ceiling
const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildExtractionPrompt(conversation: string, existing: string): string {
  return [
    'You are a memory extraction assistant. Scan this conversation between a user and a coding agent and decide if anything should be saved to long-term memory.',
    '',
    '## Memory types',
    '- user: facts about the user (role, preferences, environment, goals)',
    '- feedback: guidance about how to work (corrections, validated approaches, style preferences)',
    '- project: ongoing work, decisions, constraints not derivable from code',
    '- reference: pointers to external resources (boards, docs, URLs)',
    '',
    '## Rules',
    '1. Only durable facts that will still matter in future conversations.',
    '2. Never extract ephemeral state: current task progress, temporary debugging details, one-off values.',
    '3. Never extract things obvious from code, git history, or file structure.',
    '4. Never duplicate an existing memory (listed below).',
    '5. Each memory: kebab-case slug, short title, one-line hook, type, scope, markdown body.',
    '6. scope "user" = true across projects; scope "project" = only this project.',
    '7. At most 3 memories. If nothing qualifies, reply with exactly: NO_MEMORY',
    '8. Do not call any tools. Reply with the JSON only.',
    '',
    '## Existing memories',
    existing || '(none)',
    '',
    '## Conversation',
    conversation,
    '',
    '## Response',
    'Reply with ONLY a JSON array (no prose, no code fence):',
    '[{"slug":"user-role","title":"Short title","hook":"one-line summary","type":"user","scope":"user","body":"Full markdown fact."}]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function oneLine(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function kebab(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Coerce one model-proposed object into a valid candidate (or null). Pure. */
export function normalizeCandidate(raw: unknown): MemoryCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const slug = kebab(String(r.slug ?? ''));
  if (!MEMORY_SLUG_RE.test(slug)) return null;
  const title = oneLine(r.title).slice(0, 200);
  const body = String(r.body ?? '').trim().slice(0, 8000);
  if (!title || !body) return null;
  const type = TYPES.includes(String(r.type) as MemoryType) ? (String(r.type) as MemoryType) : 'project';
  const scope: MemoryScope = r.scope === 'user' ? 'user' : 'project';
  const firstLine = body.split(/\r?\n/).find((l) => l.trim()) ?? title;
  const hook = oneLine(r.hook || firstLine || title).slice(0, 160);
  return { slug, title, hook, type, scope, body };
}

/** Parse the extraction reply into validated candidates. Tolerates code
 *  fences and leading prose; NO_MEMORY yields []. Pure. */
export function parseExtractionResponse(text: string): MemoryCandidate[] {
  const t = String(text ?? '').trim();
  if (!t || t.includes('NO_MEMORY')) return [];
  let json = t;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) json = fence[1];
  const start = json.indexOf('[');
  const end = json.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeCandidate).filter((c): c is MemoryCandidate => !!c).slice(0, MAX_CANDIDATES);
}

function lastText(messages: ExtractionMessage[], role: string): { text: string; error: boolean } | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (String(m?.info?.role ?? '').toLowerCase() !== role) continue;
    const text = (m.parts ?? [])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
      .map((p) => String(p.text))
      .join('\n')
      .trim();
    if (!text) continue;
    return { text, error: !!m.info?.error };
  }
  return null;
}

/** The turn's final assistant message id — the message the "Memory Updated"
 *  badge attaches to. Null when that message carries no text (failed turn).
 *  Pure. */
export function turnAnswerMessageId(messages: ExtractionMessage[]): string | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (String(m?.info?.role ?? '').toLowerCase() !== 'assistant') continue;
    const hasText = (m.parts ?? []).some(
      (p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim(),
    );
    const id = typeof m.info?.id === 'string' ? m.info.id : '';
    return hasText && id ? id : null;
  }
  return null;
}

/** Extract the last user+assistant exchange, or null when the turn is too
 *  short or ended in an error. Pure. */
export function conversationSlice(messages: ExtractionMessage[], maxChars = MAX_TURN_CHARS): string | null {
  const user = lastText(messages, 'user');
  const assistant = lastText(messages, 'assistant');
  if (!user || !assistant || assistant.error) return null;
  const convo = `User: ${user.text}\n\nAssistant: ${assistant.text}`;
  if (convo.length < MIN_TURN_CHARS) return null;
  return convo.slice(0, maxChars);
}

/** Format existing memories for the prompt's dedupe list. Pure. */
export function formatExisting(
  records: Array<{ scope: MemoryScope; slug: string; text?: string | null }>,
): string {
  const lines: string[] = [];
  for (const r of records ?? []) {
    const raw = String(r.text ?? '');
    if (!raw.trim()) continue;
    const parsed = parseMemoryMarkdown(raw, { slug: r.slug, scope: r.scope });
    if (!parsed || !parsed.body.trim()) continue;
    lines.push(`- [${parsed.slug}] (${parsed.scope}/${parsed.type}) ${parsed.title} — ${parsed.hook}`);
  }
  return lines.slice(0, 60).join('\n');
}

// ---------------------------------------------------------------------------
// Backend run
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let running = false;

/** Run post-turn extraction for one completed turn. Resolves with how many
 *  memory files were written/updated. Never throws. */
export async function runMemoryExtraction(input: MemoryExtractionInput): Promise<ExtractionResult> {
  if (running) return { wrote: 0 };
  const conversation = conversationSlice(input.messages);
  if (!conversation) return { wrote: 0 };
  running = true;
  try {
    const found = await barang().memory.discover();
    const existing = formatExisting([...(found.user ?? []), ...(found.project ?? [])]);
    const prompt = buildExtractionPrompt(conversation, existing);

    const reply = await extractReply(input.sessionId, input.model, prompt);
    const candidates = parseExtractionResponse(reply);
    if (!candidates.length) return { wrote: 0 };

    // Current memory text + index per scope (from the single discover call).
    const known = { user: new Map<string, string>(), project: new Map<string, string>() } as Record<MemoryScope, Map<string, string>>;
    for (const r of found.user ?? []) known.user.set(r.slug, String(r.text ?? ''));
    for (const r of found.project ?? []) known.project.set(r.slug, String(r.text ?? ''));
    const indexes = { user: String(found.userIndex ?? ''), project: String(found.projectIndex ?? '') };
    const touched = new Set<MemoryScope>();

    let wrote = 0;
    for (const c of candidates) {
      const text = serializeMemory(c);
      if (known[c.scope].get(c.slug) === text) continue; // unchanged — no badge churn
      await barang().memory.write(c.scope, c.slug, text);
      known[c.scope].set(c.slug, text);
      indexes[c.scope] = upsertIndexLine(indexes[c.scope], c);
      touched.add(c.scope);
      wrote++;
    }
    for (const scope of touched) {
      await barang().memory.writeIndex(scope, indexes[scope]);
    }
    return { wrote };
  } catch {
    return { wrote: 0 };
  } finally {
    running = false;
  }
}

/** Create a hidden child session, prompt it, poll for the reply, delete it. */
async function extractReply(
  parentId: string,
  model: { providerID: string; modelID: string } | null,
  prompt: string,
): Promise<string> {
  let sessionId = '';
  try {
    const created = await oc.post<{ id?: string }>('/session', {
      title: EXTRACT_SESSION_TITLE,
      parentID: parentId,
    });
    sessionId = String(created?.id ?? '');
  } catch {
    // Server rejected parentID — create a plain session instead.
    try {
      const created = await oc.post<{ id?: string }>('/session', { title: EXTRACT_SESSION_TITLE });
      sessionId = String(created?.id ?? '');
    } catch {
      return '';
    }
  }
  if (!sessionId) return '';
  registerHiddenSession(sessionId);
  try {
    await oc.post(`/session/${sessionId}/prompt_async`, {
      ...(model ? { model } : {}),
      parts: [{ type: 'text', text: prompt }],
    });
    let text = '';
    for (let i = 0; i < POLL_TRIES; i++) {
      await sleep(POLL_MS);
      const status = await oc
        .get<Record<string, { type?: string }>>('/session/status')
        .catch(() => undefined);
      const msgs = await oc
        .get<ExtractionMessage[] | { value?: ExtractionMessage[] }>(`/session/${sessionId}/message`)
        .catch(() => [] as ExtractionMessage[]);
      const list = Array.isArray(msgs) ? msgs : (msgs?.value ?? []);
      const last = lastText(list, 'assistant');
      if (last) text = last.text;
      const entry = status?.[sessionId];
      const idle = !entry || entry.type === 'idle';
      if (text && idle) break;
    }
    return text;
  } catch {
    return '';
  } finally {
    forgetHiddenSession(sessionId);
    void oc.del(`/session/${sessionId}`).catch(() => {});
  }
}
