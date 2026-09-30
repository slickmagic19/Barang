// Agent panel: sessions, model/agent pickers, streaming message list,
// @file composer, permission approvals, abort. Renders opencode parts
// generically so it keeps working across server versions — every expander
// always has a body (human fields first, JSON detail fallback, never empty).
import {
  agentStore, loadSessions, createSession, selectSession, deleteSession,
  sendMessage, abortActive, respondPermission, revertMessage, unrevertSession,
  refreshActive, readSettings, deriveSessionChanges, listSelectableModels, applyModelSelection,
  type ChatMessage, type ChangeEntry,
} from '../lib/agent';
import { fsApi } from '../lib/api';
import { barang } from '../lib/transport';
import { el, md, timeAgo, debounce, roundTripChange } from '../lib/util';
import { iconEl } from './icons';
import { revealInEditor, openDiffTab } from './editor';

export interface ChatHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
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
    const div = el('div', { class: 'msg-md' });
    div.innerHTML = md(part.text);
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
  return true; // step-start/finish, tool calls, edits…
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

function renderMessages(list: HTMLElement, hooks: ChatHooks) {
  const { messages, activeId, busy, status } = agentStore.get();
  const showReasoning = readSettings().showReasoning;
  const showActivity = readSettings().showActivity;
  list.innerHTML = '';
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
  for (const m of messages) {
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
    if (role === 'user' && m.info?.id && activeId) {
      const actions = el('div', { class: 'msg-actions' });
      const btn = el('button', { class: 'msg-action', title: 'Revert this message and restore files to before it' }) as HTMLButtonElement;
      const msgId = String(m.info.id);
      const sessId = activeId;
      btn.append(iconEl('history', 12), el('span', {}, 'Revert'));
      btn.onclick = () => {
        btn.toggleAttribute('disabled', true);
        void revertMessage(sessId, msgId)
          .then(() => hooks.toast('Message reverted — files restored. “Unrevert” (clock button above) undoes this.', 'info'))
          .catch((e) => hooks.toast(`Revert failed: ${(e as Error).message}`, 'error'))
          .finally(() => btn.toggleAttribute('disabled', false));
      };
      actions.append(btn);
      wrap.append(actions);
    }
    list.append(wrap);
  }
  list.scrollTop = list.scrollHeight;
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
  const list = el('div', { class: 'chat-list' });
  const errBox = el('div', { class: 'chat-err hidden' });
  const busyRow = el('div', { class: 'busy-row hidden' });
  const busyTxt = el('span', {}, 'Agent working…');
  const btnAbort = el('button', { class: 'btn btn-danger btn-sm' }, 'Stop') as HTMLButtonElement;
  btnAbort.prepend(iconEl('stop', 11));
  btnAbort.onclick = () => void abortActive();
  busyRow.append(el('span', { class: 'spinner' }), busyTxt, btnAbort);

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
    if (changesCollapsed.has(id)) changesCollapsed.delete(id);
    else changesCollapsed.add(id);
    paintChanges();
  };

  const composer = el('div', { class: 'composer' });
  const attachBar = el('div', { class: 'attach-bar hidden' });
  const box = el('div', { class: 'composer-box' });
  const input = el('textarea', { class: 'composer-input', placeholder: 'Ask, build, refactor… (@ for files, Enter to send)' }) as HTMLTextAreaElement;
  input.rows = 2;
  const suggest = el('div', { class: 'suggest hidden' });
  const sendRow = el('div', { class: 'send-row' });
  const btnAttach = el('button', { class: 'icon-btn attach-btn', title: 'Attach file or image' }) as HTMLButtonElement;
  btnAttach.append(iconEl('clip', 15));
  const modelMini = el('select', { class: 'model-mini', title: 'Model' }) as HTMLSelectElement;
  const btnSend = el('button', { class: 'btn btn-primary btn-icon', title: 'Send (Enter)' }) as HTMLButtonElement;
  btnSend.append(iconEl('send', 14));
  sendRow.append(btnAttach, modelMini, btnSend);
  box.append(input, sendRow);
  composer.append(attachBar, box, suggest);

  panel.append(sessSection, perms, list, errBox, busyRow, changesSec, composer);

  // --- image attachments (opencode-style): files become @mentions instead ---
  interface ImgAttach { filename: string; mime: string; dataUrl: string }
  let imgAttaches: ImgAttach[] = [];
  const MAX_ATTACH = 8 * 1024 * 1024;

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
      for (const f of picked.files) {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) {
          if (f.size > MAX_ATTACH) {
            hooks.toast(`${f.name} is too large to attach (8 MB max).`, 'error');
            continue;
          }
          try {
            const r = await fsApi.readExternal(f.path);
            imgAttaches.push({ filename: r.name, mime: r.mime, dataUrl: `data:${r.mime};base64,${r.base64}` });
          } catch (e) {
            hooks.toast(`Cannot attach ${f.name}: ${(e as Error).message}`, 'error');
          }
        } else {
          insertFileMention(f.path);
        }
      }
      paintAttach();
    })();
  };

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

  const doSend = () => {
    const v = input.value;
    if ((!v.trim() && !imgAttaches.length) || agentStore.get().busy) return;
    const files = imgAttaches.map((a) => ({ mime: a.mime, filename: a.filename, url: a.dataUrl }));
    imgAttaches = [];
    paintAttach();
    input.value = '';
    autoGrow();
    void sendMessage(v, files);
  };
  btnSend.onclick = doSend;

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  };
  input.addEventListener('input', () => {
    autoGrow();
    void updateSuggest();
  });

  // @file autocomplete
  let suggestIdx = 0;
  let suggestItems: Array<{ path: string }> = [];
  const updateSuggest = async () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const m = before.match(/@([A-Za-z0-9_./\\-]*)$/);
    if (!m) {
      suggest.classList.add('hidden');
      return;
    }
    try {
      const r = await fsApi.find(m[1] || '', 8);
      suggestItems = r.results;
      suggestIdx = 0;
      if (!suggestItems.length) {
        suggest.classList.add('hidden');
        return;
      }
      suggest.innerHTML = '';
      suggestItems.forEach((it, i) => {
        const b = el('button', { class: `suggest-item${i === 0 ? ' active' : ''}` }) as HTMLButtonElement;
        b.append(iconEl('file', 13), el('span', {}, it.path));
        b.onmousedown = (e) => {
          e.preventDefault();
          insertMention(it.path);
        };
        suggest.append(b);
      });
      suggest.classList.remove('hidden');
    } catch { /* ignore */ }
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
      else if (suggestItems[suggestIdx]) insertMention(suggestItems[suggestIdx].path);
      suggest.querySelectorAll('.suggest-item').forEach((n, i) => n.classList.toggle('active', i === suggestIdx));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  btnNew.onclick = () => void createSession().catch((e) => hooks.toast(e.message, 'error'));
  btnDel.onclick = () => {
    const id = agentStore.get().activeId;
    if (!id) return;
    if (!readSettings().confirmDelete || confirm('Delete this session?')) {
      void deleteSession(id).catch((e) => hooks.toast(e.message, 'error'));
    }
  };
  btnUnrevert.onclick = () => {
    const id = agentStore.get().activeId;
    if (!id) return;
    void unrevertSession(id)
      .then(() => hooks.toast('Reverted messages restored.', 'info'))
      .catch((e) => hooks.toast(`Unrevert failed: ${(e as Error).message}`, 'error'));
  };
  sessSel.onchange = () => void selectSession(sessSel.value).catch((e) => hooks.toast(e.message, 'error'));

  function paintChanges() {
    const s = agentStore.get();
    // Changed files, derived from the session's edit/write tool calls —
    // always consistent with the loaded messages.
    const changes = deriveSessionChanges(s.messages, s.root);
    changesSec.classList.toggle('hidden', changes.length === 0);
    const collapsed = changesCollapsed.has(s.activeId ?? '');
    changesSec.classList.toggle('collapsed', collapsed);
    changesList.classList.toggle('hidden', collapsed);
    if (!changes.length) {
      prevBusy = s.busy;
      return;
    }
    changesCount.textContent = String(changes.length);
    changesList.innerHTML = '';
    for (const d of changes) {
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
    // run finished with new changes → toast once
    if (prevBusy && !s.busy) {
      hooks.toast(`Agent changed ${changes.length} file${changes.length > 1 ? 's' : ''} — see Changes.`, 'info');
    }
    prevBusy = s.busy;
  }

  const paint = () => {
    const s = agentStore.get();
    paintModelMini();
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
      const title = el('div', { class: 'perm-title' }, p.title);
      title.prepend(iconEl('shield', 14));
      card.append(title);
      if (p.detail) card.append(el('div', { class: 'perm-detail' }, p.detail.slice(0, 300)));
      const row = el('div', { class: 'perm-row' });
      const bAllow = el('button', { class: 'btn btn-primary btn-sm' }, 'Allow');
      const bOnce = el('button', { class: 'btn btn-sm' }, 'Allow once');
      const bDeny = el('button', { class: 'btn btn-sm' }, 'Deny');
      bAllow.onclick = () => void respondPermission(p, true, true).catch((e) => hooks.toast(e.message, 'error'));
      bOnce.onclick = () => void respondPermission(p, true, false).catch((e) => hooks.toast(e.message, 'error'));
      bDeny.onclick = () => void respondPermission(p, false, false).catch((e) => hooks.toast(e.message, 'error'));
      row.append(bAllow, bOnce, bDeny);
      card.append(row);
      perms.append(card);
    }
    // changed files (Cursor-style review list)
    paintChanges();
    // messages / busy / error
    renderMessages(list, hooks);
    busyRow.classList.toggle('hidden', !s.busy);
    if (s.busy) busyTxt.textContent = `Agent working… (${s.status})`;
    if (s.error) {
      errBox.innerHTML = '';
      errBox.append(iconEl('alert', 14), el('span', {}, s.error));
      errBox.classList.remove('hidden');
    } else errBox.classList.add('hidden');
    btnSend.toggleAttribute('disabled', s.busy);
  };
  const paintDebounced = debounce(paint, 120);
  agentStore.subscribe(paintDebounced);
  paint();

  // boot data (non-fatal if opencode is unreachable — banner is handled in main.ts)
  void loadSessions().then(paint).catch((e) => hooks.toast(`opencode sessions: ${e.message}`, 'error'));
}
