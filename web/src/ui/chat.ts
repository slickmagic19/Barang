// Agent panel: sessions, model/agent pickers, streaming message list,
// @file composer, permission approvals, abort. Renders opencode parts
// generically so it keeps working across server versions — every expander
// always has a body (human fields first, JSON detail fallback, never empty).
import {
  agentStore, loadSessions, createSession, selectSession, deleteSession,
  sendMessage, abortActive, respondPermission, revertMessage, unrevertSession,
  refreshActive, readSettings, writeSettings, deriveSessionChanges, listSelectableModels, applyModelSelection,
  statusTextFor, messageErrorText, todoProgress, classifyAttachFile,
  loadCommands, parseSlashCommand, sendCommand,
  compactSession, shareSession, unshareSession, markQuestionAnswered,
  type ChatMessage, type ChangeEntry,
} from '../lib/agent';
import { fsApi } from '../lib/api';
import { barang } from '../lib/transport';
import { el, md, timeAgo, debounce, roundTripChange, sliceWindow, truncateText, copyText } from '../lib/util';
import { iconEl } from './icons';
import { confirmDialog } from './dialog';
import { revealInEditor, openDiffTab } from './editor';

export interface ChatHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
  onOpenSettings?: () => void;
  onOpenPalette?: (prefill?: string) => void;
}

const SKIP_KEYS = new Set(['type', 'tool', 'name', 'state', 'status']);

function humanize(raw: string): string {
  return raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'step';
}

function statusClass(state: string): string {
  if (/complete|success|done|finish/i.test(state)) return 'is-ok';
  if (/error|fail|deny|reject/i.test(state)) return 'is-err';
  if (/run|progress|start|pending|wait|ask/i.test(state)) return 'is-run';
  return '';
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Gather human-readable prose from scalar OR block-array fields
 *  (opencode reasoning parts vary: text/reasoning/content/thinking…,
 *  sometimes as [{type:'text',text}…] blocks or empty strings). */
function collectProse(part: Record<string, unknown>): string {
  const chunks: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.trim()) chunks.push(v.trim());
    } else if (Array.isArray(v)) {
      v.forEach(push);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['text', 'thinking', 'reasoning', 'content', 'value', 'message']) push(o[k]);
    }
  };
  for (const k of ['text', 'reasoning', 'content', 'thinking', 'summary', 'message', 'description']) {
    push(part[k]);
  }
  return chunks.join('\n\n');
}

/** Last-resort body content: full JSON dump, or a placeholder when the
 *  part carries literally nothing. Guarantees non-empty expanders. */
function summarizePart(part: Record<string, unknown>): string {
  try {
    const dump = JSON.stringify(part, null, 2);
    if (dump && dump !== '{}') return dump;
  } catch { /* circular — fall through */ }
  return 'No further details for this step.';
}

/** Click-to-open buttons for any file-like paths found in free text. */
function pathLinks(host: HTMLElement, text: string) {
  const seen = new Set<string>();
  const re = /([A-Za-z0-9_@./\\-]+\.[a-z0-9]{1,5})/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(text)) && count < 3) {
    const p = m[1].replace(/^[@( "'<]+|[) "'\">.,;:]+$/g, '');
    if (!p || seen.has(p) || !/\.[a-z0-9]{1,5}$/i.test(p) || /^https?:/i.test(p)) continue;
    seen.add(p);
    count++;
    const b = el('button', { class: 'link-btn' }, `Open ${p}`);
    b.prepend(iconEl('external', 12));
    b.onclick = () => revealInEditor(p);
    host.append(b);
  }
}

/** Definition-list of an object's scalar fields (truncated, readable). */
function kvBlock(host: HTMLElement, obj: Record<string, unknown>, skip: Set<string>, maxKeys = 6) {
  const dl = el('dl', { class: 'tool-kv' });
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    const t = asText(v);
    if (t === null || t === '' || (typeof v === 'object')) continue;
    dl.append(el('dt', {}, k), el('dd', {}, t.length > 220 ? t.slice(0, 220) + '…' : t));
    if (++n >= maxKeys) break;
  }
  if (n > 0) host.append(dl);
}

function summaryRow(title: string, state: string): HTMLElement {
  const s = el('summary', {});
  const tw = el('span', { class: 'tw' });
  tw.append(iconEl('chevR', 12));
  const dot = el('span', { class: `tool-dot ${statusClass(state)}`.trim() });
  s.append(tw, dot, el('span', { class: 'tool-name' }, title));
  return s;
}

function renderPart(part: Record<string, unknown>, host: HTMLElement) {
  const type = typeof part.type === 'string' ? part.type : '';
  const lower = type.toLowerCase();

  if (typeof part.text === 'string' && (lower === 'text' || lower === '')) {
    // Long agent outputs are capped: full markdown parse + DOM for MBs of
    // text on every repaint is what freezes the UI on big runs. The full
    // text renders lazily on expand (once).
    const MAX_TEXT = 30000;
    const { text, truncated } = truncateText(part.text, MAX_TEXT);
    const div = el('div', { class: 'msg-md' });
    div.innerHTML = md(text);
    // @path chips inside messages jump to files
    div.querySelectorAll('.md-mention').forEach((n) => {
      const m = (n.textContent || '').slice(1);
      if (/^[A-Za-z0-9_./\\-]+$/.test(m) && /\.[a-z0-9]{1,5}$/i.test(m)) {
        const b = el('button', { class: 'mention-link' }, n.textContent || '');
        b.onclick = () => revealInEditor(m);
        n.replaceWith(b);
      }
    });
    host.append(div);
    if (truncated) {
      const det = el('details', { class: 'tool-row msg-more' }) as HTMLDetailsElement;
      const sum = el('summary', {}, `Show full message (${(part.text.length / 1024).toFixed(0)} KB)`);
      det.append(sum);
      let rendered = false;
      det.ontoggle = () => {
        if (det.open && !rendered) {
          rendered = true;
          const full = el('div', { class: 'msg-md' });
          full.innerHTML = md(part.text as string);
          det.append(full);
        }
      };
      host.append(det);
    }
    return;
  }

  if (lower.includes('reason') || lower.includes('think')) {
    const det = el('details', { class: 'tool-row' });
    det.append(summaryRow('Reasoning', 'running'));
    const body = el('div', { class: 'tool-body' });
    const prose = collectProse(part);
    body.append(el('pre', { class: 'tool-pre' }, (prose || summarizePart(part)).slice(0, 3000)));
    det.append(body);
    host.append(det);
    return;
  }

  // File attachments: images inline (opencode-style), others as chips.
  if (lower === 'file') {
    const view = filePartView(part);
    if (view?.kind === 'image') {
      const img = el('img', { class: 'msg-img', src: view.url, alt: view.name }) as HTMLImageElement;
      img.loading = 'lazy';
      host.append(img);
      if (view.name && view.name !== 'file') host.append(el('div', { class: 'msg-img-cap' }, view.name));
    } else {
      const chip = el('div', { class: 'msg-file' });
      chip.append(iconEl('file', 13), el('span', {}, view?.name ?? 'file'));
      host.append(chip);
    }
    return;
  }

  // Tool calls, step markers, file edits, unknown schemas: structured card.
  const state = String(part.state ?? part.status ?? '');
  const titleRaw = String(part.title ?? part.tool ?? part.name ?? humanize(type));
  const input = part.input ?? part.args ?? part.arguments;
  const title = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? `${titleRaw} · ${(JSON.stringify(input) as string).slice(0, 80)}`
    : titleRaw;
  const det = el('details', { class: 'tool-row' });
  det.append(summaryRow(title, state));

  const body = el('div', { class: 'tool-body' });
  // 1) free-text fields as readable prose
  const prose = asText(part.text ?? part.content ?? part.message ?? part.description);
  if (prose) body.append(el('pre', { class: 'tool-pre' }, prose.slice(0, 3000)));
  // 2) scalar input fields as key/value rows
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    kvBlock(body, input as Record<string, unknown>, new Set(), 6);
  } else if (asText(input)) {
    body.append(el('pre', { class: 'tool-pre' }, (asText(input) as string).slice(0, 1200)));
  }
  // 3) output / result / error payloads
  const output = part.output ?? part.result ?? part.error;
  if (output !== undefined) {
    const t = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    body.append(el('pre', { class: 'tool-pre' }, t.slice(0, 3000)));
  }
  // 4) remaining scalar fields (never show a totally empty card)
  kvBlock(body, part, new Set([...SKIP_KEYS, 'text', 'content', 'message', 'description', 'reasoning', 'input', 'args', 'arguments', 'output', 'result', 'error', 'title']), 6);
  if (!body.children.length) {
    body.append(el('pre', { class: 'tool-pre' }, summarizePart(part).slice(0, 2000)));
  }
  // 5) file paths become open-in-editor links
  try {
    pathLinks(body, JSON.stringify(part).slice(0, 4000));
  } catch { /* noop */ }
  det.append(body);
  host.append(det);
}

function isReasoningPart(p: { type?: unknown }): boolean {
  const t = typeof p.type === 'string' ? p.type.toLowerCase() : '';
  return t.includes('reason') || t.includes('think');
}

function isActivityPart(p: { type?: unknown }): boolean {
  const t = typeof p.type === 'string' ? p.type.toLowerCase() : '';
  if (!t || t === 'text') return false; // prose always stays
  if (t.includes('reason') || t.includes('think')) return false; // own toggle
  if (t.includes('permission')) return false; // approval history stays
  if (t === 'file') return false; // attachments render inline (own branch)
  return true; // step-start/finish, tool calls, edits…
}

/** Classify a file part for inline rendering: images show as thumbnails
 *  (opencode-style), anything else as a file chip. Pure (smoke-probed). */
export function filePartView(part: Record<string, unknown>):
  | { kind: 'image'; url: string; name: string }
  | { kind: 'file'; name: string }
  | null {
  if (!part || typeof part !== 'object') return null;
  if (String(part.type ?? '').toLowerCase() !== 'file') return null;
  const name = String(part.filename ?? (part as { name?: unknown }).name ?? 'file');
  const mime = String(part.mime ?? '');
  const url = String(part.url ?? '');
  const isImg = mime.toLowerCase().startsWith('image/') &&
    (/^data:image\/[a-z+]+;base64,/.test(url) || /^https?:\/\//i.test(url));
  if (isImg) return { kind: 'image', url, name };
  if (name) return { kind: 'file', name };
  return null;
}

/** History cursor math (opencode-style): idx -1 = current draft at the
 *  bottom, 0..len-1 = entries oldest-first. Pure (smoke-probed). */
export function stepHistory(len: number, idx: number, dir: 'up' | 'down'): number {
  if (len <= 0) return -1;
  if (dir === 'up') return idx <= 0 ? (idx === 0 ? 0 : len - 1) : idx - 1;
  return idx < 0 ? -1 : idx + 1 >= len ? -1 : idx + 1;
}

const HIST_KEY = 'barang:composer-history-v1';
const HIST_MAX = 100;

function loadHist(): string[] {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x).slice(-HIST_MAX) : [];
  } catch {
    return [];
  }
}

// Composer history (opencode-style ↑↓): every submitted prompt/command,
// newest last, persisted across restarts. Navigation state is per composer
// (single composer instance in the app).
let histList: string[] = loadHist();
let histIdx = -1;
let histDraft = '';

/** Record a submitted composer line (test seam: smoke drives the real fn). */
export function pushComposerHist(text: string) {
  const t = String(text ?? '').trim();
  if (!t) return;
  if (histList[histList.length - 1] !== t) {
    histList.push(t);
    if (histList.length > HIST_MAX) histList = histList.slice(-HIST_MAX);
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(histList));
    } catch { /* private mode */ }
  }
  histIdx = -1;
}

function diffStatus(d: ChangeEntry): { label: string; cls: string; icon: 'plus' | 'trash' | 'pencil' } {
  if (d.status === 'added') return { label: 'Added', cls: 'is-added', icon: 'plus' };
  if (d.status === 'deleted') return { label: 'Deleted', cls: 'is-deleted', icon: 'trash' };
  return { label: 'Modified', cls: 'is-modified', icon: 'pencil' };
}

/** Open a change for review: verified side-by-side when the session patch
 *  still applies to the current file, whole-file view for fresh writes,
 *  colored patch modal otherwise. Never shows wrong content. */
async function openChangeReview(d: ChangeEntry, hooks: ChatHooks) {
  let current: string;
  try {
    const f = await fsApi.read(d.rel);
    if (f.binary) {
      hooks.toast(`${d.rel} is binary — no diff preview.`, 'error');
      return;
    }
    current = f.content ?? '';
  } catch (e) {
    // Unreadable (moved/deleted/out-of-root) — the patch alone still reviews.
    if (d.patch) openPatchModal(d.rel, d.patch, 'Current file is unreadable — showing the session patch.');
    else hooks.toast(`Cannot open change: ${(e as Error).message}`, 'error');
    return;
  }
  if (d.kind === 'write' || !d.patch) {
    await openDiffTab(d.rel, '', current);
    return;
  }
  const before = roundTripChange(current, d.patch);
  if (before === null) {
    openPatchModal(d.rel, d.patch, 'The file changed since this edit — showing the session patch instead of a side-by-side.');
  } else {
    await openDiffTab(d.rel, before, current);
  }
}

/** Fallback review: the raw session patch, syntax-tinted, with an Open File jump. */
function openPatchModal(file: string, patch: string, note?: string) {
  const overlay = el('div', { class: 'patch-overlay' });
  const dialog = el('div', { class: 'patch-modal', role: 'dialog', 'aria-label': `Patch for ${file}` });
  const head = el('div', { class: 'patch-head' });
  head.append(el('span', { class: 'patch-title' }, file));
  const btnClose = el('button', { class: 'icon-btn', title: 'Close (Esc)' }) as HTMLButtonElement;
  btnClose.append(iconEl('x', 15));
  head.append(btnClose);
  const body = el('div', { class: 'patch-body' });
  if (note) body.append(el('p', { class: 'patch-note' }, note));
  const pre = el('pre', { class: 'patch-pre' });
  pre.innerHTML = patch
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map((l) => {
      const cls = /^\+[^+]/.test(l) || l === '+' ? 'patch-add' : /^-[^-]/.test(l) || l === '-' ? 'patch-del' : /^@@/.test(l) ? 'patch-hunk' : 'patch-ctx';
      return `<span class="${cls}">${l || ' '}</span>`;
    })
    .join('\n');
  body.append(pre);
  const foot = el('div', { class: 'patch-foot' });
  const btnOpen = el('button', { class: 'btn btn-sm' }, 'Open file');
  btnOpen.onclick = () => {
    close();
    revealInEditor(file);
  };
  foot.append(btnOpen);
  dialog.append(head, body, foot);
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
}

// Tracks run completion for the "changed N files" toast.
let prevBusy = false;
// Sessions the user collapsed in Changes (new sessions default open).
const changesCollapsed = new Set<string>();

const CHAT_WINDOW = 150; // rendered messages (older hidden behind a button)
const CHANGES_CAP = 200; // rendered change rows (counts stay exact)
let chatShown = CHAT_WINDOW;
let lastChatSession: string | null | undefined = undefined;
let chatKeepScroll = false; // "show more" preserves position instead of jumping
let requestChatPaint: (() => void) | null = null;
let dcSig = '';
let dcOut: ChangeEntry[] = [];

function renderMessages(list: HTMLElement, hooks: ChatHooks) {
  const { messages, activeId, busy, status, statusInfo, error } = agentStore.get();
  const showReasoning = readSettings().showReasoning;
  const showActivity = readSettings().showActivity;
  // Scroll anchor: capture BEFORE clearing (innerHTML resets scrollTop).
  const prevTop = list.scrollTop;
  const prevHeight = list.scrollHeight;
  const atBottom = prevHeight - prevTop - list.clientHeight < 48;
  list.innerHTML = '';
  if (activeId !== lastChatSession) {
    lastChatSession = activeId;
    chatShown = CHAT_WINDOW; // fresh session starts at the tail
  }
  if (!messages.length && (busy || status === 'connecting')) {
    // Loading skeleton (connecting / first response streaming in).
    for (let i = 0; i < 2; i++) {
      const sk = el('div', { class: 'msg is-agent' });
      sk.append(el('div', { class: 'skel-msg' }));
      list.append(sk);
    }
    return;
  }
  if (!messages.length) {
    const empty = el('div', { class: 'chat-empty' });
    empty.append(
      el('div', { class: 'chat-empty-title' }, 'Ask the agent anything'),
      'It can read, edit, and run your project. Type @ to attach a file. Enter sends, Shift+Enter adds a line.',
    );
    list.append(empty);
  }
  // Window the history: giant sessions render only the tail (older messages
  // behind a button). Full rebuilds each stream frame stay O(window).
  const { visible, hidden } = sliceWindow(messages, chatShown);
  if (hidden > 0) {
    const more = el('button', { class: 'msg-more-btn' }, `Show ${Math.min(hidden, CHAT_WINDOW)} earlier messages (${hidden} hidden)`) as HTMLButtonElement;
    more.onclick = () => {
      chatShown += CHAT_WINDOW;
      chatKeepScroll = true;
      requestChatPaint?.();
    };
    list.append(more);
  }
  const shownRunErrors = new Set<string>();
  for (const m of visible) {
    const role = String(m.info?.role ?? 'assistant').toLowerCase();
    const parts = (m.parts ?? []).filter(
      (p) => (showReasoning || !isReasoningPart(p as { type?: unknown })) &&
        (showActivity || !isActivityPart(p as { type?: unknown })),
    );
    if (!parts.length) continue; // fully hidden message — skip the empty bubble
    const wrap = el('div', { class: `msg ${role === 'user' ? 'is-user' : 'is-agent'}` });
    const meta = el('div', { class: 'msg-meta' });
    meta.append(`${role === 'user' ? 'You' : 'Agent'}${m.info?.time?.created ? ` · ${timeAgo(m.info.time.created)}` : ''}`);
    wrap.append(meta);
    for (const p of parts) renderPart(p as Record<string, unknown>, wrap);
    // Server-reported run failures live on the assistant message — show them
    // inline in the transcript, not just as a toast.
    if (role !== 'user') {
      const runErr = messageErrorText(m.info?.error);
      if (runErr) {
        shownRunErrors.add(runErr);
        const eb = el('div', { class: 'msg-runerr' });
        eb.append(iconEl('alert', 13), el('span', {}, runErr));
        wrap.append(eb);
      }
    }
    if (role === 'user' && m.info?.id && activeId) {
      const actions = el('div', { class: 'msg-actions' });
      const btn = el('button', { class: 'msg-action msg-revert', title: 'Revert this message and restore files to before it' }) as HTMLButtonElement;
      const msgId = String(m.info.id);
      const sessId = activeId;
      btn.append(iconEl('history', 12), el('span', {}, 'Revert'));
      if (agentStore.get().busy) btn.toggleAttribute('disabled', true);
      btn.onclick = () => {
        void (async () => {
          const ok = await confirmDialog({
            title: 'Revert this message?',
            message: 'The message and everything after it will be hidden, and files restored to before it. You can undo with Unrevert (clock button above).',
            confirmLabel: 'Revert',
          });
          if (!ok) return;
          btn.toggleAttribute('disabled', true);
          try {
            await revertMessage(sessId, msgId);
            hooks.toast('Message reverted — files restored. “Unrevert” (clock button above) undoes this.', 'info');
          } catch (e) {
            hooks.toast(`Revert failed: ${(e as Error).message}`, 'error');
          } finally {
            btn.toggleAttribute('disabled', false);
          }
        })();
      };
      actions.append(btn);
      wrap.append(actions);
    }
    list.append(wrap);
  }
  // Transport/submit failures (store error) also land in the transcript —
  // a toast alone is gone before the user reads it. Skipped when the same
  // text already renders on a run-error row above.
  if (error && !shownRunErrors.has(error)) {
    const eb = el('div', { class: 'msg is-agent' });
    eb.append(el('div', { class: 'msg-meta' }, 'Agent'));
    const row = el('div', { class: 'msg-runerr' });
    row.append(iconEl('alert', 13), el('span', {}, error));
    eb.append(row);
    list.append(eb);
  }
  if (chatKeepScroll) {
    // "Show more" prepends above: hold the reading position steady.
    list.scrollTop = list.scrollHeight - prevHeight + prevTop;
    chatKeepScroll = false;
  } else if (atBottom || visible.length <= CHAT_WINDOW) {
    list.scrollTop = list.scrollHeight;
  }
  // else: user scrolled up mid-stream — leave them there (no more yanking).
}

export function initChat(panel: HTMLElement, hooks: ChatHooks) {
  panel.classList.add('agent-panel');

  const sessSection = el('div', { class: 'agent-section sess-section' });
  const sessRow = el('div', { class: 'sess-row' });
  const sessSel = el('select', { class: 'sess-sel', title: 'Session' }) as HTMLSelectElement;
  const btnNew = el('button', { class: 'icon-btn', title: 'New session' }) as HTMLButtonElement;
  btnNew.append(iconEl('plus', 15));
  const btnDel = el('button', { class: 'icon-btn', title: 'Delete session' }) as HTMLButtonElement;
  btnDel.append(iconEl('trash', 15));
  const btnUnrevert = el('button', { class: 'icon-btn', title: 'Restore messages hidden by revert' }) as HTMLButtonElement;
  btnUnrevert.append(iconEl('history', 15));
  sessRow.append(sessSel, btnNew, btnUnrevert, btnDel);
  sessSection.append(sessRow);

  const perms = el('div', { class: 'perms' });
  const quests = el('div', { class: 'quests' });
  const list = el('div', { class: 'chat-list' });
  const errBox = el('div', { class: 'chat-err hidden' });
  const busyRow = el('div', { class: 'busy-row hidden' });
  const busyTxt = el('span', {}, 'Agent working…');
  const btnAbort = el('button', { class: 'btn btn-danger btn-sm' }, 'Stop') as HTMLButtonElement;
  btnAbort.prepend(iconEl('stop', 11));
  btnAbort.onclick = () => void abortActive();
  busyRow.append(el('span', { class: 'spinner' }), busyTxt, btnAbort);

  // Agent todo checklist (server-owned; read-only — the agent manages it).
  const todosSec = el('div', { class: 'todos-sec hidden' });
  const todosToggle = el('button', { class: 'todos-toggle', title: 'Collapse/expand agent todos' }) as HTMLButtonElement;
  const todosTw = el('span', { class: 'tw' });
  todosTw.append(iconEl('chevR', 12));
  const todosTitle = el('span', { class: 'todos-title' }, 'Todos');
  todosToggle.append(todosTw, todosTitle);
  const todosList = el('div', { class: 'todos-list' });
  todosSec.append(todosToggle, todosList);
  todosToggle.onclick = () => {
    const id = agentStore.get().activeId ?? '';
    todosTouched.add(id); // explicit user choice beats the auto rules below
    if (todosCollapsed.has(id)) todosCollapsed.delete(id);
    else todosCollapsed.add(id);
    paintTodos();
  };

  const changesSec = el('div', { class: 'changes-sec hidden' });
  const changesHead = el('div', { class: 'changes-head' });
  const changesToggle = el('button', { class: 'changes-toggle', title: 'Collapse/expand changed files' }) as HTMLButtonElement;
  const changesTw = el('span', { class: 'tw' });
  changesTw.append(iconEl('chevR', 12));
  const changesTitle = el('span', { class: 'changes-title' }, 'Changes');
  const changesCount = el('span', { class: 'changes-count' });
  changesToggle.append(changesTw, changesTitle, changesCount);
  const changesRefresh = el('button', { class: 'icon-btn', title: 'Refresh changed files' }) as HTMLButtonElement;
  changesRefresh.append(iconEl('refresh', 13));
  changesRefresh.onclick = () => void refreshActive().catch((e) => hooks.toast(e.message, 'error'));
  changesHead.append(changesToggle, changesRefresh);
  const changesList = el('div', { class: 'changes-list' });
  changesSec.append(changesHead, changesList);
  changesToggle.onclick = () => {
    const id = agentStore.get().activeId ?? '';
    changesTouched.add(id); // explicit user choice beats the auto rules below
    if (changesCollapsed.has(id)) changesCollapsed.delete(id);
    else changesCollapsed.add(id);
    paintChanges();
  };

  const composer = el('div', { class: 'composer' });
  const attachBar = el('div', { class: 'attach-bar hidden' });
  const box = el('div', { class: 'composer-box' });
  const input = el('textarea', { class: 'composer-input', placeholder: 'Ask, build, refactor… (@ for files, paste/drop images, Enter to send)' }) as HTMLTextAreaElement;
  input.rows = 2;
  const suggest = el('div', { class: 'suggest hidden' });
  const sendRow = el('div', { class: 'send-row' });
  const btnAttach = el('button', { class: 'icon-btn attach-btn', title: 'Attach file or image (or paste / drop into the composer)' }) as HTMLButtonElement;
  btnAttach.append(iconEl('clip', 15));
  const modelMini = el('select', { class: 'model-mini', title: 'Model' }) as HTMLSelectElement;
  const effortMini = el('select', { class: 'effort-mini', title: 'Reasoning effort' }) as HTMLSelectElement;
  const btnSend = el('button', { class: 'btn btn-primary btn-icon', title: 'Send (Enter)' }) as HTMLButtonElement;
  btnSend.append(iconEl('send', 14));
  sendRow.append(btnAttach, modelMini, effortMini, btnSend);
  box.append(input, sendRow);
  composer.append(attachBar, box, suggest);

  panel.append(sessSection, perms, quests, list, errBox, busyRow, todosSec, changesSec, composer);

  // --- attachments (opencode-style): images inline, files as @mentions ---
  interface ImgAttach { filename: string; mime: string; dataUrl: string }
  let imgAttaches: ImgAttach[] = [];

  const paintAttach = () => {
    attachBar.innerHTML = '';
    attachBar.classList.toggle('hidden', imgAttaches.length === 0);
    imgAttaches.forEach((a, i) => {
      const chip = el('span', { class: 'attach-chip' });
      const thumb = el('img', { class: 'attach-thumb', src: a.dataUrl, alt: a.filename }) as HTMLImageElement;
      chip.append(thumb, el('span', { class: 'attach-name' }, a.filename));
      const x = el('button', { class: 'attach-x', title: 'Remove attachment' }) as HTMLButtonElement;
      x.append(iconEl('x', 11));
      x.onclick = () => {
        imgAttaches = imgAttaches.filter((_, j) => j !== i);
        paintAttach();
      };
      chip.append(x);
      attachBar.append(chip);
    });
  };

  const insertFileMention = (absPath: string) => {
    const root = agentStore.get().root || '';
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const fwd = absPath.replace(/\\/g, '/');
    const rel = root && norm(absPath).startsWith(norm(root) + '/') ? fwd.slice(norm(root).length + 1) : absPath;
    const mention = /\s/.test(rel) ? `@"${rel}" ` : `@${rel} `;
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + mention + input.value.slice(pos);
    input.focus();
    autoGrow();
  };

  btnAttach.onclick = () => {
    void (async () => {
      let picked;
      try {
        picked = await barang().app.pickFiles();
      } catch (e) {
        if (!/cancelled/i.test((e as Error).message)) hooks.toast((e as Error).message, 'error');
        return;
      }
      await addPickedFiles(picked.files.map((f) => ({ name: f.name, path: f.path, size: f.size, blob: null })));
    })();
  };

  // Paste + drag-drop (opencode-style): images attach inline, other files
  // become @mentions. One shared router for picker/paste/drop.
  const blobToDataUrl = (b: Blob) =>
    new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result ?? ''));
      fr.onerror = () => rej(new Error('unreadable'));
      fr.readAsDataURL(b);
    });

  interface PickedFile { name: string; path?: string; size: number; blob?: Blob | null }

  const addPickedFiles = async (files: PickedFile[]) => {
    for (const f of files) {
      const name = f.name || 'pasted-image.png';
      const route = classifyAttachFile(name, f.size);
      if (route === 'skip') continue;
      if (route === 'too-large') {
        hooks.toast(`${name} is too large to attach (8 MB max).`, 'error');
        continue;
      }
      if (route === 'image') {
        try {
          if (f.path) {
            const r = await fsApi.readExternal(f.path);
            imgAttaches.push({ filename: r.name, mime: r.mime, dataUrl: `data:${r.mime};base64,${r.base64}` });
          } else if (f.blob) {
            const dataUrl = await blobToDataUrl(f.blob);
            imgAttaches.push({ filename: name, mime: dataUrl.slice(5, dataUrl.indexOf(';')), dataUrl });
          } else {
            hooks.toast(`Cannot attach ${name}: no image data.`, 'error');
          }
        } catch (e) {
          hooks.toast(`Cannot attach ${name}: ${(e as Error).message}`, 'error');
        }
      } else if (f.path) {
        insertFileMention(f.path);
      } else {
        hooks.toast(`Cannot attach ${name}: drag the file in or use the attach button.`, 'error');
      }
    }
    paintAttach();
  };

  const domFiles = (list: FileList | File[] | undefined): PickedFile[] =>
    [...(list ?? [])].map((f) => ({
      name: f.name,
      path: (f as File & { path?: string }).path,
      size: f.size,
      blob: f,
    }));

  input.addEventListener('paste', (e) => {
    const files = domFiles(e.clipboardData?.files);
    if (!files.length) return; // plain text — let it through
    e.preventDefault();
    void addPickedFiles(files);
  });

  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  composer.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    composer.classList.add('drag-over');
  });
  composer.addEventListener('dragover', (e) => {
    if (composer.classList.contains('drag-over')) e.preventDefault();
  });
  composer.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) composer.classList.remove('drag-over');
  });
  composer.addEventListener('drop', (e) => {
    dragDepth = 0;
    composer.classList.remove('drag-over');
    const files = domFiles(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    void addPickedFiles(files).finally(() => input.focus());
  });

  const paintModelMini = () => {
    const s = agentStore.get();
    const models = listSelectableModels();
    if (modelMini.dataset.count !== String(models.length + 1)) {
      modelMini.innerHTML = '';
      modelMini.append(el('option', { value: '' }, 'Auto') as HTMLOptionElement);
      let lastProv = '';
      for (const m of models) {
        if (m.providerID !== lastProv) {
          const g = document.createElement('optgroup');
          g.label = m.providerID;
          modelMini.append(g);
          lastProv = m.providerID;
        }
        (modelMini.lastElementChild as HTMLOptGroupElement)?.append(el('option', { value: m.label }, m.modelID) as HTMLOptionElement);
      }
      modelMini.dataset.count = String(models.length + 1);
    }
    const cur = s.model ? `${s.model.providerID}/${s.model.modelID}` : '';
    modelMini.value = cur;
    modelMini.title = s.model ? `Model: ${cur}` : 'Model: auto (opencode default)';
  };
  modelMini.onchange = () => applyModelSelection(modelMini.value);

  // Reasoning effort (opencode model variants): options come from the
  // selected model's advertised variants; Default omits the field.
  const paintEffortMini = () => {
    const s = agentStore.get();
    const entry = s.model
      ? s.providerModels.find((m) => m.providerID === s.model!.providerID && m.modelID === s.model!.modelID)
      : undefined;
    const variants = entry?.variants ?? [];
    const key = `${s.model ? `${s.model.providerID}/${s.model.modelID}` : 'auto'}|${variants.join(',')}`;
    if (effortMini.dataset.key !== key) {
      effortMini.innerHTML = '';
      effortMini.append(el('option', { value: '' }, 'Default') as HTMLOptionElement);
      for (const v of variants) {
        effortMini.append(el('option', { value: v }, v[0].toUpperCase() + v.slice(1)) as HTMLOptionElement);
      }
      effortMini.dataset.key = key;
    }
    const saved = readSettings().effort;
    const active = saved && variants.includes(saved) ? saved : '';
    effortMini.value = active;
    effortMini.title = variants.length
      ? `Reasoning effort${active ? `: ${active}` : ' (Default)'} — ${s.model ? `${s.model.providerID}/${s.model.modelID}` : 'auto'}`
      : 'Reasoning effort: this model advertises no variants';
  };
  effortMini.onchange = () => {
    const settings = readSettings();
    settings.effort = effortMini.value || null;
    writeSettings(settings);
    paintEffortMini();
  };

  // opencode TUI built-ins the server doesn't expose as /commands.
  // 1:1 behavior: compact/undo/redo/share/unshare act, models/agents/help
  // open the matching UI.
  const LOCAL_COMMANDS: Record<string, { description: string; run: (args: string) => Promise<void> }> = {
    compact: {
      description: 'Summarize the session to free context',
      run: async () => {
        const id = agentStore.get().activeId;
        if (!id) {
          hooks.toast('Open or start a session first.', 'error');
          return;
        }
        const ok = await compactSession(id);
        if (!ok && !agentStore.get().error) hooks.toast('Pick a model first (composer model picker).', 'error');
      },
    },
    undo: {
      description: 'Revert the last message and restore files',
      run: async () => {
        const s = agentStore.get();
        if (!s.activeId) return;
        const lastUser = [...s.messages].reverse().find((m) => String(m?.info?.role ?? '').toLowerCase() === 'user' && m?.info?.id);
        if (!lastUser?.info?.id) {
          hooks.toast('Nothing to undo.', 'error');
          return;
        }
        try {
          await revertMessage(s.activeId, String(lastUser.info.id));
          hooks.toast('Reverted — Unrevert (clock button) undoes this.', 'info');
        } catch (e) {
          hooks.toast(`Undo failed: ${(e as Error).message}`, 'error');
        }
      },
    },
    redo: {
      description: 'Restore messages hidden by revert',
      run: async () => {
        const id = agentStore.get().activeId;
        if (!id) return;
        try {
          await unrevertSession(id);
          hooks.toast('Reverted messages restored.', 'info');
        } catch (e) {
          hooks.toast(`Redo failed: ${(e as Error).message}`, 'error');
        }
      },
    },
    share: {
      description: 'Publish a public link to this session',
      run: async () => {
        const id = agentStore.get().activeId;
        if (!id) return;
        try {
          const url = await shareSession(id);
          if (!url) {
            hooks.toast('Shared, but the server returned no link.', 'error');
            return;
          }
          const ok = await copyText(url);
          hooks.toast(ok ? `Session shared — link copied: ${url}` : `Session shared: ${url}`, ok ? 'info' : 'error');
        } catch (e) {
          hooks.toast(`Share failed: ${(e as Error).message}`, 'error');
        }
      },
    },
    unshare: {
      description: 'Remove the public link',
      run: async () => {
        const id = agentStore.get().activeId;
        if (!id) return;
        try {
          await unshareSession(id);
          hooks.toast('Session unshared.', 'info');
        } catch (e) {
          hooks.toast(`Unshare failed: ${(e as Error).message}`, 'error');
        }
      },
    },
    models: {
      description: 'Open model settings',
      run: async () => {
        hooks.onOpenSettings?.();
      },
    },
    agents: {
      description: 'Open agent settings',
      run: async () => {
        hooks.onOpenSettings?.();
      },
    },
    help: {
      description: 'Keyboard shortcuts',
      run: async () => {
        hooks.onOpenPalette?.('help');
      },
    },
  };

  const doSend = async () => {
    const v = input.value;
    if ((!v.trim() && !imgAttaches.length) || agentStore.get().busy) return;
    // Slash commands go to the command endpoint (server list) or the local
    // TUI-parity map — never the prompt endpoint.
    const slash = !imgAttaches.length ? parseSlashCommand(v) : null;
    if (slash) {
      const local = LOCAL_COMMANDS[slash.name];
      if (local) {
        pushComposerHist(v.trim());
        input.value = '';
        autoGrow();
        suggest.classList.add('hidden');
        await local.run(slash.args);
        return;
      }
      const known = await loadCommands().catch(() => []);
      if (known.length && !known.some((c) => c.name === slash.name)) {
        hooks.toast(`Unknown command: /${slash.name}`, 'error');
        return; // keep the text so it can be fixed
      }
      pushComposerHist(v.trim());
      input.value = '';
      autoGrow();
      suggest.classList.add('hidden');
      await sendCommand(slash.name, slash.args);
      return;
    }
    const files = imgAttaches.map((a) => ({ mime: a.mime, filename: a.filename, url: a.dataUrl }));
    imgAttaches = [];
    paintAttach();
    input.value = '';
    autoGrow();
    pushComposerHist(v);
    void sendMessage(v, files);
  };
  btnSend.onclick = () => void doSend();

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  };
  input.addEventListener('input', () => {
    autoGrow();
    histIdx = -1; // typing abandons history navigation
    void updateSuggest();
  });

  // @file + /command autocomplete
  let suggestIdx = 0;
  let suggestItems: Array<{ path: string; sub?: string; kind: 'file' | 'cmd' }> = [];
  const paintSuggest = () => {
    suggest.innerHTML = '';
    suggestItems.forEach((it, i) => {
      const b = el('button', { class: `suggest-item${i === 0 ? ' active' : ''}` }) as HTMLButtonElement;
      b.append(iconEl(it.kind === 'cmd' ? 'prompt' : 'file', 13), el('span', {}, it.path));
      if (it.sub) b.append(el('span', { class: 'suggest-sub' }, it.sub));
      b.onmousedown = (e) => {
        e.preventDefault();
        insertSuggest(it);
      };
      suggest.append(b);
    });
    suggest.classList.toggle('hidden', suggestItems.length === 0);
  };
  const updateSuggest = async () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const cmdM = /^\/([A-Za-z0-9_-]*)$/.exec(before);
    if (cmdM) {
      // Leading-slash command being typed: server list + local TUI-parity
      // commands, so /compact & co complete even offline from the server.
      try {
        const list = await loadCommands().catch(() => []);
        const seen = new Set(list.map((c) => c.name));
        const local = Object.entries(LOCAL_COMMANDS)
          .filter(([name]) => !seen.has(name))
          .map(([name, c]) => ({ name, description: c.description }));
        const all = [
          ...local.map((c) => ({ name: c.name, description: c.description })),
          ...list.map((c) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : '' })),
        ];
        const q = cmdM[1].toLowerCase();
        suggestItems = all
          .filter((c) => c.name.toLowerCase().startsWith(q))
          .slice(0, 8)
          .map((c) => ({ path: `/${c.name}`, sub: (c.description ?? '').slice(0, 80), kind: 'cmd' as const }));
        suggestIdx = 0;
        paintSuggest();
      } catch { /* ignore */ }
      return;
    }
    const m = before.match(/@([A-Za-z0-9_./\\-]*)$/);
    if (!m) {
      suggest.classList.add('hidden');
      return;
    }
    try {
      const r = await fsApi.find(m[1] || '', 8);
      suggestItems = r.results.map((x) => ({ path: x.path, kind: 'file' as const }));
      suggestIdx = 0;
      if (!suggestItems.length) {
        suggest.classList.add('hidden');
        return;
      }
      paintSuggest();
    } catch { /* ignore */ }
  };
  const insertSuggest = (it: { path: string; kind: 'file' | 'cmd' }) => {
    const pos = input.selectionStart ?? input.value.length;
    const after = input.value.slice(pos);
    if (it.kind === 'cmd') {
      const before = input.value.slice(0, pos).replace(/\/[A-Za-z0-9_-]*$/, `${it.path} `);
      input.value = before + after;
    } else {
      insertMention(it.path);
      return;
    }
    suggest.classList.add('hidden');
    input.focus();
    autoGrow();
  };
  const insertMention = (path: string) => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos).replace(/@[A-Za-z0-9_./\\-]*$/, `@${path} `);
    input.value = before + input.value.slice(pos);
    suggest.classList.add('hidden');
    input.focus();
    autoGrow();
  };
  input.addEventListener('keydown', (e) => {
    if (!suggest.classList.contains('hidden') && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab' || e.key === 'Enter')) {
      if (e.key === 'Enter' && e.shiftKey) return; // allow newline
      e.preventDefault();
      if (e.key === 'ArrowDown') suggestIdx = Math.min(suggestIdx + 1, suggestItems.length - 1);
      else if (e.key === 'ArrowUp') suggestIdx = Math.max(suggestIdx - 1, 0);
      else if (suggestItems[suggestIdx]) insertSuggest(suggestItems[suggestIdx]);
      suggest.querySelectorAll('.suggest-item').forEach((n, i) => n.classList.toggle('active', i === suggestIdx));
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
      // opencode-style history (suggest already handled above): Up recalls
      // older, Down moves back toward the draft. Recalled text stays out of
      // the suggest popup so arrows keep walking history.
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 'up' : 'down';
      if (dir === 'up' && histIdx === -1) histDraft = input.value;
      histIdx = stepHistory(histList.length, histIdx, dir as 'up' | 'down');
      input.value = histIdx === -1 ? histDraft : (histList[histIdx] ?? '');
      autoGrow();
      suggest.classList.add('hidden');
      input.selectionStart = input.selectionEnd = input.value.length;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  });

  btnNew.onclick = () => void createSession().catch((e) => hooks.toast(e.message, 'error'));
  btnDel.onclick = () => {
    void (async () => {
      const id = agentStore.get().activeId;
      if (!id) return;
      const sess = agentStore.get().sessions.find((x) => x.id === id);
      if (readSettings().confirmDelete) {
        const ok = await confirmDialog({
          title: 'Delete session?',
          message: `Delete "${sess?.title || 'Untitled'}" and all its messages? This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
      }
      void deleteSession(id).catch((e) => hooks.toast(e.message, 'error'));
    })();
  };
  btnUnrevert.onclick = () => {
    const id = agentStore.get().activeId;
    if (!id) return;
    void unrevertSession(id)
      .then(() => hooks.toast('Reverted messages restored.', 'info'))
      .catch((e) => hooks.toast(`Unrevert failed: ${(e as Error).message}`, 'error'));
  };
  sessSel.onchange = () => void selectSession(sessSel.value).catch((e) => hooks.toast(e.message, 'error'));

// Sessions the user collapsed in Todos (new sessions default open).
const todosCollapsed = new Set<string>();
// Sessions the user explicitly toggled (auto-collapse only fires before that).
const todosTouched = new Set<string>();
const changesTouched = new Set<string>();

function paintTodos() {
  const s = agentStore.get();
  const todos = s.todos ?? [];
  todosSec.classList.toggle('hidden', todos.length === 0);
  if (!todos.length) return;
  const { label } = todoProgress(todos);
  todosTitle.textContent = label;
  const id = s.activeId ?? '';
  // Fully-done checklists start collapsed (one line, not a wall of checks).
  const allDone = todos.every((t) => String(t.status ?? '').toLowerCase() === 'completed');
  const collapsed = todosCollapsed.has(id) || (!todosTouched.has(id) && allDone);
  todosSec.classList.toggle('collapsed', collapsed);
  todosList.classList.toggle('hidden', collapsed);
  todosList.innerHTML = '';
  for (const t of todos) {
    const st = String(t.status ?? '').toLowerCase();
    const row = el('div', { class: `todo-row is-${st || 'pending'}` });
    const box = el('span', { class: 'todo-box' });
    // Zero-glyph states (chrome must stay emoji/dingbat-free for the dom
    // probe): completed draws a CSS check, in-progress a dot, the rest an
    // empty box — text style carries completed vs cancelled.
    if (st === 'completed') box.append(el('span', { class: 'todo-check' }));
    else if (st === 'in_progress') box.append(el('span', { class: 'todo-dot' }));
    row.append(box, el('span', { class: 'todo-text' }, String(t.content ?? '')));
    if (t.priority && t.priority !== 'medium') row.title = `Priority: ${t.priority}`;
    todosList.append(row);
  }
}

  function paintChanges() {
    const s = agentStore.get();
    // Changed files, derived from the session's edit/write tool calls —
    // always consistent with the loaded messages. Memoized: derivation only
    // re-runs when the message list actually changes, not on every paint.
    const lastId = s.messages.length ? String(s.messages[s.messages.length - 1]?.info?.id ?? s.messages.length) : '';
    const sig = `${s.root}|${s.messages.length}|${lastId}`;
    let changes: ChangeEntry[];
    if (sig === dcSig) {
      changes = dcOut;
    } else {
      changes = deriveSessionChanges(s.messages, s.root);
      dcSig = sig;
      dcOut = changes;
    }
    changesSec.classList.toggle('hidden', changes.length === 0);
    // Big change sets start collapsed (header + count stay visible).
    const collapsed = changesCollapsed.has(s.activeId ?? '') ||
      (!changesTouched.has(s.activeId ?? '') && changes.length > 8);
    changesSec.classList.toggle('collapsed', collapsed);
    changesList.classList.toggle('hidden', collapsed);
    if (!changes.length) {
      prevBusy = s.busy;
      return;
    }
    changesCount.textContent = String(changes.length);
    changesList.innerHTML = '';
    // Cap rendered rows (thousands of changed files must not build
    // thousands of DOM rows + icons every paint — counts stay exact).
    const shown = changes.slice(0, CHANGES_CAP);
    for (const d of shown) {
      const st = diffStatus(d);
      const row = el('button', { class: `change-row ${st.cls}`, title: `${st.label} — click to review` }) as HTMLButtonElement;
      const stat = el('span', { class: 'change-stat' });
      if (d.kind === 'write') {
        stat.append(el('span', { class: 'stat-add' }, 'new'));
      } else {
        stat.append(
          el('span', { class: 'stat-add' }, `+${d.additions}`),
          document.createTextNode(' '),
          el('span', { class: 'stat-del' }, `−${d.deletions}`),
        );
      }
      row.append(
        iconEl(st.icon, 13),
        el('span', { class: 'change-path' }, d.rel),
        stat,
      );
      row.onclick = () => void openChangeReview(d, hooks);
      changesList.append(row);
    }
    if (changes.length > shown.length) {
      changesList.append(el('div', { class: 'scm-none' }, `…and ${changes.length - shown.length} more (open a diff from search, or commit in batches)`));
    }
    // run finished with new changes → toast once
    if (prevBusy && !s.busy) {
      hooks.toast(`Agent changed ${changes.length} file${changes.length > 1 ? 's' : ''} — see Changes.`, 'info');
    }
    prevBusy = s.busy;
  }

  const paint = () => {
    const s = agentStore.get();
    paintModelMini();
    paintEffortMini();
    // sessions
    const cur = sessSel.value;
    sessSel.innerHTML = '';
    for (const sess of s.sessions) {
      const o = el('option', { value: sess.id }, `${sess.title || 'Untitled'} — ${sess.time?.updated ? timeAgo(sess.time.updated) : ''}`) as HTMLOptionElement;
      sessSel.append(o);
    }
    if (s.activeId) sessSel.value = s.activeId;
    else if (cur) sessSel.value = cur;
    // permissions
    perms.innerHTML = '';
    for (const p of s.permissions) {
      const card = el('div', { class: 'perm-card' });
      const head = el('div', { class: 'perm-head' });
      head.append(iconEl('shield', 14));
      head.append(el('span', { class: 'perm-kind' }, p.kind || 'permission'));
      head.append(el('span', { class: 'perm-sub' }, 'needs approval'));
      card.append(head);
      if (p.target) card.append(el('div', { class: 'perm-target' }, p.target));
      else if (p.title) card.append(el('div', { class: 'perm-target' }, p.title));
      if (p.detail) card.append(el('div', { class: 'perm-detail' }, p.detail));
      const row = el('div', { class: 'perm-row' });
      const bAllow = el('button', { class: 'btn btn-primary btn-sm' }, 'Allow');
      const bOnce = el('button', { class: 'btn btn-sm' }, 'Allow once');
      const bDeny = el('button', { class: 'btn btn-sm' }, 'Deny');
      // Server enum (verified live): once | always | reject.
      bAllow.onclick = () => void respondPermission(p, 'always').catch((e) => hooks.toast(e.message, 'error'));
      bOnce.onclick = () => void respondPermission(p, 'once').catch((e) => hooks.toast(e.message, 'error'));
      bDeny.onclick = () => void respondPermission(p, 'reject').catch((e) => hooks.toast(e.message, 'error'));
      row.append(bAllow, bOnce, bDeny);
      card.append(row);
      perms.append(card);
    }
    // changed files (Cursor-style review list)
    paintChanges();
    // agent todos (server-owned checklist)
    paintTodos();
    // Agent question-tool waits: 1.18 serve has no answer route, so picking
    // an option stops the stuck run and sends the choice as a new message.
    quests.innerHTML = '';
    for (const q of s.questions) {
      const card = el('div', { class: 'quest-card' });
      const title = el('div', { class: 'quest-title' }, q.items.length > 1 ? `The agent has ${q.items.length} questions` : (q.header || 'The agent has a question'));
      title.prepend(iconEl('help', 14));
      card.append(title);
      const picks = new Map<number, string>();
      q.items.forEach((item, qi) => {
        if (q.items.length > 1) card.append(el('div', { class: 'quest-q' }, item.question));
        else card.append(el('div', { class: 'quest-q' }, item.question || q.question));
        if (item.options.length) {
          const opts = el('div', { class: 'quest-opts' });
          item.options.forEach((o) => {
            const lab = el('label', { class: 'quest-opt' }) as HTMLLabelElement;
            const radio = el('input', { type: 'radio', name: `quest-${q.questionID}-${qi}` }) as HTMLInputElement;
            radio.value = o.label;
            radio.onchange = () => {
              if (radio.checked) picks.set(qi, o.label);
            };
            lab.append(radio, el('span', { class: 'quest-opt-label' }, o.label));
            if (o.description) lab.append(el('span', { class: 'quest-opt-desc' }, o.description));
            opts.append(lab);
          });
          card.append(opts);
        }
      });
      const hasOptions = q.items.some((item) => item.options.length > 0);
      if (q.repeated) {
        card.append(el('div', { class: 'quest-warn' }, 'Asked again — the previous answer may not have registered. If it repeats, rephrase the choice in chat instead.'));
      }
      card.append(el('div', { class: 'quest-note' }, hasOptions
        ? 'Pick an option, then Send answer — this stops the run and replies with your choice.'
        : 'This question has no options — Stop the run, then reply in chat.'));
      const row = el('div', { class: 'perm-row' });
      if (hasOptions) {
        const bSend = el('button', { class: 'btn btn-primary btn-sm' }, 'Send answer') as HTMLButtonElement;
        bSend.onclick = () => {
          bSend.toggleAttribute('disabled', true);
          void (async () => {
            try {
              const lines = q.items.map((item, qi) => {
                const pick = picks.get(qi);
                if (!pick) return null;
                const what = item.question || q.question;
                return `Answering your question "${what}": I choose "${pick}". Please continue with this answer — do not ask the same question again.`;
              }).filter((l): l is string => !!l);
              if (!lines.length) {
                hooks.toast('Pick an option first.', 'error');
                return;
              }
              if (agentStore.get().busy) await abortActive();
              if (agentStore.get().busy) {
                hooks.toast('Stop did not take — answer in chat once the run ends.', 'error');
                return;
              }
              const ok = await sendMessage(lines.join('\n'));
              if (ok) markQuestionAnswered(q);
              else hooks.toast('Could not send the answer — try again from the composer.', 'error');
            } finally {
              bSend.toggleAttribute('disabled', false);
            }
          })();
        };
        row.append(bSend);
      }
      const bStop = el('button', { class: 'btn btn-danger btn-sm' }, 'Stop the run');
      bStop.onclick = () => void abortActive();
      row.append(bStop);
      card.append(row);
      quests.append(card);
    }
    // messages / busy / error
    renderMessages(list, hooks);
    busyRow.classList.toggle('hidden', !s.busy);
    if (s.busy) {
      busyTxt.textContent = s.status === 'stalled' && s.lastActivity
        ? `Agent stalled — ${s.lastActivity} (Stop, then send again)`
        : statusTextFor(s.status, s.statusInfo?.attempt ?? 0);
    }
    if (s.error) {
      errBox.innerHTML = '';
      errBox.append(iconEl('alert', 14), el('span', {}, s.error));
      errBox.classList.remove('hidden');
    } else errBox.classList.add('hidden');
    btnSend.toggleAttribute('disabled', s.busy);
  };
  const paintDebounced = debounce(paint, 120);
  requestChatPaint = paint;
  agentStore.subscribe(paintDebounced);
  paint();

  // boot data (non-fatal if opencode is unreachable — banner is handled in main.ts)
  void loadSessions().then(paint).catch((e) => hooks.toast(`opencode sessions: ${e.message}`, 'error'));
}
