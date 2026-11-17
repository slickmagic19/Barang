// Style contract for the editor chrome. There is no headless browser in this
// project, so the invariants that regress silently (a stray scrollbar in the
// tab strip, notch tabs creeping back, session tabs drifting away from file
// tabs) are pinned against the stylesheet itself.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Comments are stripped first so declaration parsing never trips over them.
const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const editorTs = readFileSync(new URL('../../ui/editor.ts', import.meta.url), 'utf8');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every declaration block of an exact selector (order preserved). */
function bodies(selector: string): string[] {
  const re = new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(re)].map((m) => m[1]);
}

/** All values declared for one property across the selector's blocks. */
function decl(selector: string, prop: string): string[] {
  const out: string[] = [];
  for (const body of bodies(selector)) {
    for (const part of body.split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === prop) out.push(part.slice(i + 1).trim());
    }
  }
  return out;
}

const rootVars = bodies(':root').join('\n');
function cssVar(name: string): string {
  const m = new RegExp(`${escape(name)}\\s*:\\s*([^;]+)`).exec(rootVars);
  return (m?.[1] ?? '').trim();
}

/** Colors defined in the Monaco theme (ui/editor.ts). */
function monacoTheme(): { background: string; cursor: string } {
  const pick = (key: string) =>
    new RegExp(`'${escape(key)}':\\s*'(#[0-9a-fA-F]{6})'`).exec(editorTs)?.[1] ?? '';
  return { background: pick('editor.background'), cursor: pick('editorCursor.foreground') };
}

describe('tab strip', () => {
  it('never paints a scrollbar in the strip (the stray right-edge bar)', () => {
    expect(decl('.tabs', 'overflow-y')).toContain('hidden');
    expect(decl('.tabs', 'overflow-x')).toContain('auto');
    expect(decl('.tabs', 'scrollbar-width')).toContain('none');
    expect(bodies('.tabs::-webkit-scrollbar').join(' ')).toContain('display: none');
  });

  it('is a flat 35px row with no per-tab gaps', () => {
    expect(cssVar('--tab-h')).toBe('35px');
    expect(decl('.tabs', 'height')).toContain('var(--tab-h)');
    expect(decl('.tabs', 'gap')).toContain('0');
  });

  it('uses square tabs separated by hairlines, not notches', () => {
    expect(decl('.tab', 'border-radius')).toContain('0');
    expect(decl('.tab', 'border-radius')).not.toContain('8px');
    // No 2px accent underline (the old notch); the seam is 1px and invisible.
    expect(css).not.toMatch(/\.tab\.active::after[^}]*height:\s*2px/);
    expect(decl('.tab.active::after', 'height')).toEqual(['1px']);
    expect(decl('.tab.active::after', 'background')).toEqual(['var(--tab-surface)']);
    expect(decl('.tab', 'box-shadow').join(' ')).toContain('inset -1px 0 0');
  });

  it('merges the active tab into the editor surface', () => {
    const monaco = /'editor\.background':\s*'(#[0-9a-fA-F]{6})'/.exec(editorTs)?.[1];
    expect(monaco).toBeTruthy();
    expect(cssVar('--tab-surface').toLowerCase()).toBe(monaco!.toLowerCase());
    expect(decl('.tab.active', 'background')).toContain('var(--tab-surface)');
  });

  it('keeps the close slot stable while dirty (dot ⇄ X swap)', () => {
    expect(decl('.tab-x', 'width')).toContain('var(--tab-x-slot)');
    expect(bodies('.tab.is-dirty .tab-x').join(' ')).toContain('visibility: hidden');
    expect(bodies('.tab.is-dirty:hover .dirty-dot').join(' ')).toContain('visibility: hidden');
  });
});

describe('session strip parity', () => {
  it('runs at the same height and type size as the file strip', () => {
    expect(decl('.sess-row', 'height')).toContain('var(--tab-h)');
    expect(decl('.sess-tab', 'height')).toContain('100%');
    expect(decl('.sess-tab', 'font-size')).toEqual(decl('.tab', 'font-size'));
    expect(decl('.sess-tab', 'box-shadow').join(' ')).toContain('inset -1px 0 0');
    // The agent panel's surface, not the code surface — the seam has to match
    // whatever sits directly underneath the strip.
    expect(cssVar('--tab-surface-panel')).toBe('var(--panel)');
    expect(decl('.sess-tab.active', 'background')).toEqual(['var(--tab-surface-panel)']);
    expect(decl('.sess-tab.active::after', 'height')).toEqual(['1px']);
  });

  it('hides its own scrollbar too', () => {
    expect(decl('.sess-list', 'scrollbar-width')).toContain('none');
    expect(bodies('.sess-list::-webkit-scrollbar').join(' ')).toContain('display: none');
  });

  it('left-aligns the session list against the panel edge', () => {
    // Full-bleed strip: the section owns the padding, so the row starts at 0.
    expect(decl('.agent-section.sess-section', 'padding').join('|')).toBe('0');
    expect(decl('.sess-list', 'padding')).toContain('0');
  });

  it('casts a shadow so scrolled messages never bleed into the strip', () => {
    // Pinned by the Electron smoke harness too (dom.headerShadow).
    expect(decl('.agent-section.sess-section', 'box-shadow').join(' ')).not.toBe('');
    expect(decl('.agent-section.sess-section', 'box-shadow').join(' ')).not.toContain('none');
  });
});

describe('brand palette', () => {
  it('carries the Barang violet-blue on a near-black surface', () => {
    expect(cssVar('--brand')).toBe('#8b7bff');
    expect(cssVar('--brand-strong')).toBe('#a79bff');
    expect(cssVar('--bg')).toBe('#08080a');
    expect(cssVar('--bg-soft')).toBe('#0b0b0e');
    expect(cssVar('--panel')).toBe('#0e0e12');
    expect(cssVar('--panel-2')).toBe('#131318');
  });

  it('paints links and mentions with the brand accent', () => {
    expect(decl('.msg-md a', 'color')).toContain('var(--brand-strong)');
    expect(decl('.md-mention', 'color')).toContain('var(--brand-strong)');
    expect(decl('.md-mention', 'background')).toContain('var(--brand-dim)');
    expect(decl('.mention-link', 'border').join(' ')).toContain('var(--brand-line)');
    expect(decl('.link-btn', 'color')).toContain('var(--brand-strong)');
    expect(decl('a', 'color')).toContain('var(--brand-strong)');
  });

  it('keeps the editor surface and caret on-brand', () => {
    expect(cssVar('--tab-surface')).toBe('#060608');
    expect(monacoTheme()).toMatchObject({ background: '#060608', cursor: '#a79bff' });
  });
});

describe('agent transcript (Qoder 1:1)', () => {
  it('scrolls a framed list with a floating jump-to-latest pill', () => {
    expect(decl('.chat-scroll', 'position')).toEqual(['relative']);
    expect(decl('.scroll-bottom', 'position')).toEqual(['absolute']);
    expect(decl('.scroll-bottom.is-off', 'opacity')).toEqual(['0']);
  });

  it('renders user turns as the brand-violet card, with no per-turn header', () => {
    expect(cssVar('--user-bubble-bg')).toBe('#13111f');
    expect(cssVar('--user-bubble-border')).toBe('#8b7bff33');
    expect(decl('.msg.is-user .msg-body.is-bubble', 'background')).toEqual(['var(--user-bubble-bg)']);
    expect(decl('.msg.is-user .msg-body.is-bubble', 'border-radius')).toEqual(['10px']);
    // Qoder has no avatar/role row above each turn.
    expect(css).not.toContain('.msg-avatar');
    expect(css).not.toContain('.msg-head');
  });

  it('draws activity as flat muted rows, not cards', () => {
    expect(decl('.tool-row.step-row, .tool-row.step-block', 'border')).toEqual(['0']);
    expect(decl('.tool-row.step-row, .tool-row.step-block', 'background')).toEqual(['transparent']);
    expect(decl('.step-body', 'padding')).toEqual(['2px 0 4px 22px']);
    expect(bodies('.tool-row.step-row > summary, .tool-row.step-block > summary').join(' ')).toContain('font-size: 12px');
    expect(decl('.step-chev', 'transition').join(' ')).toContain('transform');
  });

  it('styles the file cards + Qoder "N Files Changed" card', () => {
    expect(decl('.file-op', 'border-radius')).toEqual(['8px']);
    expect(decl('.file-op-stat', 'margin-left')).toEqual(['auto']);
    expect(bodies('.file-op-ext.ext-ts, .file-op-ext.ext-tsx').join(' ')).toContain('#3b82f626');
    expect(bodies('.file-op-letter.is-A').join(' ')).toContain('var(--green)');
    expect(bodies('.file-op-letter.is-M').join(' ')).toContain('var(--yellow)');
    expect(decl('.file-changes', 'border-radius')).toEqual(['9px']);
    expect(decl('.file-changes-wrap', 'display')).toEqual(['grid']);
    expect(decl('.file-changes.is-collapsed .file-changes-wrap', 'grid-template-rows')).toEqual(['0fr']);
    expect(bodies('.file-changes.is-new').join(' ')).toContain('cardIn');
  });

  it('renders the under-turn action strip icon-only', () => {
    expect(decl('.msg-action', 'width')).toEqual(['24px']);
    expect(decl('.msg-actions', 'opacity')).toEqual(['.5']);
    expect(bodies('.msg-actions').join(' ')).not.toContain('position: absolute');
  });

  it('ships the Qoder motion set', () => {
    expect(css).toContain('@keyframes caretPulse');
    expect(css).toContain('@keyframes cardIn');
    expect(css).toContain('@keyframes shimmer');
    expect(css).toContain('@keyframes spin');
    expect(decl('.stream-caret', 'animation').join(' ')).toContain('caretPulse');
    // The busy row animates one thing only (its spinner).
    expect(css).not.toContain('.busy-dots');
  });

  it('folds a long turn into one "Worked on N actions" line', () => {
    const summary = bodies('.tool-row.step-block.worked-block > summary').join(' ');
    expect(summary).toContain('justify-content: space-between');
    expect(summary).toContain('font-size: 13px');
    expect(decl('.worked-label', 'font-weight')).toEqual(['500']);
    expect(decl('.worked-body', 'padding')).toEqual(['2px 0 2px 2px']);
  });

  it('animates only keyed elements (a rebuild must not replay motion)', () => {
    expect(css).toContain('@keyframes msgIn');
    expect(css).toContain('@keyframes stepIn');
    expect(decl('.msg.msg-enter', 'animation').join(' ')).toContain('msgIn');
    expect(decl('.tool-row.is-new', 'animation').join(' ')).toContain('stepIn');
    // Regression guard: an unconditional animation on rebuilt prose flickers.
    expect(decl('.msg.is-agent .msg-md', 'animation')).toEqual([]);
    expect(decl('.msg-md', 'animation')).toEqual([]);
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(motion).toContain('.msg.msg-enter');
    expect(motion).toContain('animation: none !important');
  });

  it('adds copy chrome to fenced code blocks', () => {
    expect(decl('.msg-md pre.md-code', 'position')).toEqual(['relative']);
    expect(decl('.md-copy', 'position')).toEqual(['absolute']);
  });

  it('keeps a compact square send control', () => {
    expect(decl('.send-row .btn-primary', 'width')).toEqual(['30px']);
    expect(decl('.send-row .btn-primary', 'height')).toEqual(['30px']);
    expect(decl('.composer-box', 'border-radius')).toEqual(['14px']);
  });
});

describe('explorer tracking indicators', () => {
  it('reserves a right gutter for badges', () => {
    expect(bodies('.tree-badges').length).toBeGreaterThan(0);
    expect(decl('.tree-badges', 'margin-left')).toContain('auto');
  });

  it('styles git letters, folder counts and the unsaved dot', () => {
    expect(bodies('.git-badge').length).toBeGreaterThan(0);
    expect(decl('.git-count', 'border-radius')).toContain('999px');
    expect(decl('.tree-dot', 'border-radius')).toContain('50%');
    expect(decl('.tree-dot', 'background')).toContain('var(--yellow)');
  });

  it('keeps rows compact', () => {
    expect(decl('.tree-label', 'height')).toContain('24px');
  });
});

describe('quick diff (VS Code quickDiffDecorator + QuickDiffWidget)', () => {
  it('caps the active tab with the brand color, files and sessions alike', () => {
    expect(decl('.tab.active', 'box-shadow').join(' ')).toContain('inset 0 2px 0 var(--brand)');
    expect(decl('.sess-tab.active', 'box-shadow').join(' ')).toContain('inset 0 2px 0 var(--brand)');
  });

  it('draws the gutter glyphs like VS Code: hatched bars, no removal marks', () => {
    expect(decl('.dirty-diff-glyph', 'margin-left')).toEqual(['4px']);
    expect(decl('.dirty-diff-glyph', 'width').join(' ')).toContain('4px');
    // Slim by default, thicker only while the margin is hovered.
    expect(bodies('.monaco-editor .margin:hover .dirty-diff-glyph').join(' ')).toContain('width: 8px');
    expect(decl('.dirty-diff-added.pattern', 'background-image').join(' ')).toContain('#9ece6a');
    expect(decl('.dirty-diff-added.pattern', 'background-image').join(' ')).toContain('repeating-linear-gradient');
    expect(decl('.dirty-diff-modified.pattern', 'background-image').join(' ')).toContain('#e0af68');
    // Removals are only shown in the changes peek — no pink gutter marker.
    expect(css).not.toContain('.dirty-diff-deleted');
  });

  it('tints the count badges with the brand, quietly', () => {
    expect(decl('.git-count', 'background')).toEqual(['var(--brand-dim)']);
    expect(decl('.git-count', 'color')).toEqual(['var(--brand-strong)']);
    // Source-control chip: solid brand badge with a cut-out ring.
    expect(decl('.scm-badge', 'background')).toEqual(['var(--brand)']);
    expect(decl('.scm-badge', 'box-shadow')).toEqual(['0 0 0 1.5px var(--bg-soft)']);
    expect(css).not.toContain('#0078d4');
  });

  it('keeps one motion cue per row: spinner only, no busy dots', () => {
    expect(decl('.busy-row', 'display')).toEqual(['flex']);
    expect(css).not.toContain('.busy-dots');
    expect(css).not.toContain('dotPulse');
  });

  it('animates a running step with a spinning ring + label shimmer', () => {
    expect(decl('.tool-row > summary.is-running .step-ic', 'position')).toEqual(['relative']);
    expect(bodies('.tool-row > summary.is-running .step-ic::after').join(' ')).toContain('animation: spin');
    expect(decl('.tool-row > summary.is-running .tool-name', 'animation')).toEqual(['shimmer 1.8s linear infinite']);
    expect(decl('.tool-row > summary.is-running .tool-name', '-webkit-background-clip')).toEqual(['text']);
    // ...and they switch off under prefers-reduced-motion.
    expect(css).toContain('.tool-row > summary.is-running .step-ic::after,\n  .tool-row > summary.is-running .tool-name,');
  });

  it('slides the peek under the editor, header above the embedded diff', () => {
    expect(decl('.diff-pane', 'flex')).toEqual(['0 0 55%']);
    expect(decl('.diff-pane.hidden', 'display')).toEqual(['none']);
    expect(decl('.diff-editor', 'flex')).toEqual(['1 1 auto']);
    expect(decl('.diff-bar', 'height')).toEqual(['30px']);
    expect(decl('.diff-bar-file', 'font-weight')).toEqual(['600']);
    expect(decl('.diff-bar-add', 'color')).toEqual(['var(--green)']);
    expect(decl('.diff-bar .diff-nav', 'width')).toEqual(['22px']);
  });

  it('makes the tab git letter the entry point to the changes view', () => {
    expect(decl('.tab-git', 'cursor')).toEqual(['pointer']);
  });
});
