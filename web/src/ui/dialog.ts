// Themed confirmation dialog (replaces every native confirm() so destructive
// actions match the app instead of flashing OS chrome). Cancel is focused by
// default (safe choice); Enter activates the focused button, Esc cancels.
import { el } from '../lib/util';
import { iconEl } from './icons';

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    const overlay = el('div', { class: 'confirm-overlay' });
    const dialog = el('div', { class: 'confirm-modal', role: 'alertdialog', 'aria-label': opts.title ?? 'Confirm' });
    const head = el('div', { class: 'confirm-head' });
    const mark = el('span', { class: `confirm-mark${opts.danger === false ? '' : ' is-danger'}` });
    mark.append(iconEl('alert', 16));
    head.append(mark, el('span', { class: 'confirm-title' }, opts.title ?? 'Are you sure?'));
    const body = el('p', { class: 'confirm-message' }, opts.message);
    const actions = el('div', { class: 'confirm-actions' });
    const btnCancel = el('button', { class: 'btn' }, 'Cancel') as HTMLButtonElement;
    const btnOk = el('button', { class: `btn ${opts.danger === false ? 'btn-primary' : 'btn-danger'}` }, opts.confirmLabel ?? 'Confirm') as HTMLButtonElement;
    btnCancel.onclick = () => finish(false);
    btnOk.onclick = () => finish(true);
    actions.append(btnCancel, btnOk);
    dialog.append(head, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(false);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.contains(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    btnCancel.focus();
  });
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
}

/** Themed text-input dialog (branch names, stash messages). Null = cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    const overlay = el('div', { class: 'confirm-overlay' });
    const dialog = el('div', { class: 'confirm-modal', role: 'dialog', 'aria-label': opts.title });
    const head = el('div', { class: 'confirm-head' });
    const mark = el('span', { class: 'confirm-mark' });
    mark.append(iconEl('prompt', 16));
    head.append(mark, el('span', { class: 'confirm-title' }, opts.title));
    dialog.append(head);
    if (opts.message) dialog.append(el('p', { class: 'confirm-message' }, opts.message));
    const input = el('input', { class: 'prompt-input', placeholder: opts.placeholder ?? '' }) as HTMLInputElement;
    input.value = opts.initial ?? '';
    dialog.append(input);
    const actions = el('div', { class: 'confirm-actions' });
    const btnCancel = el('button', { class: 'btn' }, 'Cancel') as HTMLButtonElement;
    const btnOk = el('button', { class: 'btn btn-primary' }, opts.confirmLabel ?? 'Confirm') as HTMLButtonElement;
    btnCancel.onclick = () => finish(null);
    const submit = () => finish(input.value.trim() === '' && (opts.initial ?? '') === '' ? null : input.value.trim());
    btnOk.onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    actions.append(btnCancel, btnOk);
    dialog.append(actions);
    overlay.append(dialog);
    document.body.append(overlay);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.contains(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    input.focus();
    input.select();
  });
}
