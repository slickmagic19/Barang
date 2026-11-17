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
