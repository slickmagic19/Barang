// VSCode-style context menu primitive: dark, viewport-clamped, keyboard
// navigable, single-open. Callers preventDefault their event then show().
import { el } from '../lib/util';
import { iconEl, type IconName } from './icons';

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
}
export type MenuEntry = MenuItem | { sep: true };

let openMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeContextMenu() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  openMenu?.remove();
  openMenu = null;
}

export function isContextMenuOpen(): boolean {
  return openMenu !== null;
}

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeContextMenu();
  const menu = el('div', { class: 'ctx-menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const e of entries) {
    if ('sep' in e) {
      menu.append(el('div', { class: 'ctx-sep' }));
      continue;
    }
    const b = el('button', { class: `ctx-item${e.danger ? ' is-danger' : ''}`, role: 'menuitem' }) as HTMLButtonElement;
    if (e.icon) b.append(iconEl(e.icon, 14));
    else b.append(el('span', { class: 'ctx-pad' }));
    b.append(el('span', { class: 'ctx-label' }, e.label));
    if (e.disabled) b.toggleAttribute('disabled', true);
    else {
      b.onclick = () => {
        closeContextMenu();
        e.run?.();
      };
    }
    buttons.push(b);
    menu.append(b);
  }
  if (!buttons.length) return;
  document.body.append(menu);
  openMenu = menu;

  // Clamp into the viewport (flip up/left near edges).
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 8))}px`;

  let focusIdx = -1;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeContextMenu();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      if (!enabled.length) return;
      focusIdx = ev.key === 'ArrowDown' ? (focusIdx + 1) % enabled.length : (focusIdx - 1 + enabled.length) % enabled.length;
      enabled[focusIdx].focus();
    }
  };
  const onPointer = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) closeContextMenu();
  };
  const onBlur = () => closeContextMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', onBlur);
  cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('blur', onBlur);
  };
}
