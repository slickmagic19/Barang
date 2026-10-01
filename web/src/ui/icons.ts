// Barang icon set: inline SVG, stroke-based, currentColor.
// Zero dependencies, zero emoji, crisp at any DPI. All icons share a 24px
// grid, 1.8px stroke, round caps — one visual voice across the whole app.
export type IconName =
  | 'logo' | 'folder' | 'folderOpen' | 'file' | 'filePlus' | 'folderPlus'
  | 'refresh' | 'trash' | 'plus' | 'x' | 'chevL' | 'chevR' | 'chevD'
  | 'send' | 'stop' | 'shield' | 'spark' | 'search' | 'prompt'
  | 'alert' | 'check' | 'info' | 'history' | 'external' | 'dot' | 'gear' | 'pencil' | 'clip' | 'download';

const S = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS: Record<IconName, string> = {
  logo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M7 9.5l3 3-3 3"/><path d="M12.5 15.5H17"/></svg>`,
  folder: S('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  folderOpen: S('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v1.5H3.5z"/><path d="M3.5 12.5h17V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  file: S('<path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/>'),
  filePlus: S('<path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/><path d="M11 14v6M8 17h6"/>'),
  folderPlus: S('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 9v7M8.5 12.5h7" stroke-width="2.2"/>'),
  refresh: S('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3.5V9h-5.5"/>'),
  trash: S('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13.5h9l1-13.5"/><path d="M10 11v6M14 11v6"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevL: S('<path d="M15 5.5L8.5 12l6.5 6.5"/>'),
  chevR: S('<path d="M9 5.5l6.5 6.5L9 18.5"/>'),
  chevD: S('<path d="M5.5 9L12 15.5 18.5 9"/>'),
  send: S('<path d="M21.5 2.5L11 13"/><path d="M21.5 2.5L15 21.5l-4-8.5-8.5-4z"/>'),
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
  shield: S('<path d="M12 3l7 2.8v5.4c0 4.8-3.4 7.8-7 9-3.6-1.2-7-4.2-7-9V5.8z"/><path d="M9.3 11.8l2 2 3.6-4.2"/>'),
  spark: S('<path d="M12 3.5l1.8 4.8 4.8 1.8-4.8 1.8L12 16.7l-1.8-4.8-4.8-1.8 4.8-1.8z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>'),
  prompt: S('<path d="M4 17.5l6-6-6-6"/><path d="M12 19.5h8"/>'),
  alert: S('<path d="M12 3.5L22 20H2z"/><path d="M12 9.5V14"/><path d="M12 17h.01"/>'),
  check: S('<path d="M4.5 12.5l5 5L19.5 7"/>'),
  info: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>'),
  history: S('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><path d="M12 7.5V12l3 2"/>'),
  external: S('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L10.5 13.5"/><path d="M19.5 14v5.5h-15v-15H10"/>'),
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><g fill="currentColor" stroke="none"><rect x="11" y="1.7" width="2" height="3.8" rx="0.9"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(45 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(90 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(135 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(180 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(225 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(270 12 12)"/><rect x="11" y="1.7" width="2" height="3.8" rx="0.9" transform="rotate(315 12 12)"/></g><circle cx="12" cy="12" r="6.3"/><circle cx="12" cy="12" r="2.6"/></svg>`,
  dot: `<svg viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3.2"/></svg>`,
  pencil: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  clip: S('<path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  download: S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10.5l5 5 5-5"/><path d="M12 15.5V3"/>'),
};

/** Span wrapper sized for flex layouts (icons align to text baseline). */
export function iconEl(name: IconName, size = 15): HTMLElement {
  const s = document.createElement('span');
  s.className = `ic ic-${name}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name].replace('<svg', `<svg width="${size}" height="${size}"`);
  return s;
}
