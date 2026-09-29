// Tiny typed pub/sub store. No framework, no deps — keeps the shell <10KB.
export type Listener = () => void;

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get(): T {
      return state;
    },
    set(next: Partial<T> | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (p: T) => T)(state) : { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<string | Node | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'string') continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

/** Render markdown: fences, headings, lists, quotes, rules, inline code,
 *  bold, links. Escapes HTML first; fences are extracted before block parse. */
export function md(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks: string[] = [];
  const fenced = esc.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_m, lang, code) => {
    blocks.push(
      `<pre class="md-code"><code data-lang="${lang || 'text'}">${code.replace(/\n$/, '')}</code></pre>`,
    );
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s: string) =>
    s
      .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
      .replace(/@([A-Za-z0-9_./\\-]+)/g, '<span class="md-mention">@$1</span>');
  const lines = fenced.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\u0000\d+\u0000$/.test(line.trim())) {
      closeList();
      out.push(line.trim());
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`${inline(line)}<br>`);
  }
  closeList();
  return out
    .join('')
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? '');
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function debounce<F extends (...a: never[]) => void>(fn: F, ms: number): F {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: never[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as F;
}

/** Copy text to the clipboard (async API with legacy fallback). */
export async function copyText(text: string): Promise<boolean> {  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Minimal unified-diff engine (opencode `edit` patches).
 *  forward: base + patch → result. reverse: result − patch → base.
 *  Both return null unless every hunk applies EXACTLY (context verified).
 *  roundTripChange additionally forward-verifies: reverse(current) must
 *  forward-apply back to current byte-for-byte, so a displayed side-by-side
 *  can never show wrong content — failures fall back to the raw patch view. */
interface PatchHunk {
  lines: Array<{ k: ' ' | '-' | '+'; t: string }>;
}

export function parseUnifiedPatch(patch: string): PatchHunk[] | null {
  const hunks: PatchHunk[] = [];
  let cur: PatchHunk | null = null;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(raw)) return null;
      cur = { lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // headers (Index:, ---, +++) skipped
    if (raw.startsWith(' ') || raw.startsWith('-') || raw.startsWith('+')) {
      cur.lines.push({ k: raw[0] as ' ' | '-' | '+', t: raw.slice(1) });
    } else if (raw === '' || raw === '\\ No newline at end of file') {
      continue;
    } else {
      return null;
    }
  }
  return hunks.length ? hunks : null;
}

/** Reconstruct the pre-edit file by reverse-applying, forward-verified. */
export function roundTripChange(current: string, patch: string): string | null {
  const hunks = parseUnifiedPatch(patch);
  if (!hunks) return null;
  const cur = current.split(/\r?\n/); // patches are LF-oriented; normalize CRLF
  // Pass 1 — locate: walk hunks to find each hunk's start offset in current.
  // For reverse, '+' lines are consumed from current, '-' lines are inserted.
  const before: string[] = [];
  let at = 0;
  for (const h of hunks) {
    // Find the hunk start: first consumed line (' ' or '+') must match.
    let start = -1;
    for (let i = at; i <= cur.length; i++) {
      let ok = true;
      let j = i;
      for (const l of h.lines) {
        if (l.k === ' ' || l.k === '+') {
          if (j >= cur.length || cur[j] !== l.t) {
            ok = false;
            break;
          }
          j++;
        }
      }
      if (ok) {
        start = i;
        break;
      }
      // Bound the search: hunks appear in order; don't scan unboundedly far
      // past already-consumed output (keeps pathological patches cheap).
      if (i - at > 20000) return null;
    }
    if (start < 0) return null;
    for (let i = at; i < start; i++) before.push(cur[i]);
    at = start;
    for (const l of h.lines) {
      if (l.k === ' ') before.push(cur[at++]);
      else if (l.k === '+') at++;
      else before.push(l.t);
    }
  }
  for (let i = at; i < cur.length; i++) before.push(cur[i]);
  // Pass 2 — forward-verify: patch applied to `before` must equal `current`.
  const fwd = applyForward(before, hunks);
  if (fwd === null || fwd.join('\n') !== cur.join('\n')) return null;
  return before.join('\n');
}

function applyForward(before: string[], hunks: PatchHunk[]): string[] | null {
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    // Locate hunk start in `before` via its context/removal lines.
    let start = -1;
    outer: for (let i = at; i <= before.length; i++) {
      let j = i;
      for (const l of h.lines) {
        if (l.k === ' ' || l.k === '-') {
          if (j >= before.length || before[j] !== l.t) continue outer;
          j++;
        }
      }
      start = i;
      break;
    }
    if (start < 0) return null;
    for (let i = at; i < start; i++) out.push(before[i]);
    at = start;
    for (const l of h.lines) {
      if (l.k === ' ') out.push(before[at++]);
      else if (l.k === '-') at++;
      else out.push(l.t);
    }
  }
  for (let i = at; i < before.length; i++) out.push(before[i]);
  return out;
}
