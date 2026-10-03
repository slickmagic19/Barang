// Pomodoro sidebar view: timer ring, cycle dots, transport buttons and a
// fully customizable settings section. The wall-clock loop lives here;
// phase math + persistence live in lib/pomodoro (unit-probed in smoke).
import {
  pomoStore, readPomoSettings, writePomoSettings, pomoDurationMs, pomoNext,
  formatClock, type PomoPhase, type PomoSettings,
} from '../lib/pomodoro';
import { readSettings } from '../lib/agent';
import { resolveSoundUrl, playNotificationSound } from '../lib/notify';
import { barang } from '../lib/transport';
import { el } from '../lib/util';
import { iconEl } from './icons';

export interface PomoHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
}

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

const PHASE_LABEL: Record<PomoPhase, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' };
const PHASE_COLOR: Record<PomoPhase, string> = { focus: '#9ece6a', short: '#e0af68', long: '#3b8eea' };

/** Dots filled for the current set (long-break completion shows full until
 *  the next focus lands). Pure. */
export function pomoDotsFilled(cycle: number, every: number): number {
  const n = Math.max(1, Math.floor(every) || 4);
  if (cycle <= 0) return 0;
  const r = cycle % n;
  return r === 0 ? n : r;
}

let loopOn = false;
function ensureLoop(notify: (completed: PomoPhase) => void) {
  if (loopOn) return;
  loopOn = true;
  setInterval(() => {
    const s = pomoStore.get();
    if (s.status !== 'running') return;
    const remaining = s.endsAt - Date.now();
    if (remaining > 0) {
      pomoStore.set({ remainingMs: remaining });
      return;
    }
    finishPhase(notify);
  }, 1000);
}

function finishPhase(notify: (completed: PomoPhase) => void, silent = false) {
  const s = pomoStore.get();
  const nx = pomoNext(s.phase, s.cycle, s.settings.cycles);
  if (!silent) notify(s.phase);
  const autoNext = nx.phase === 'focus' ? s.settings.autoFocus : s.settings.autoBreaks;
  const full = pomoDurationMs(s.settings, nx.phase);
  if (autoNext) {
    pomoStore.set({ phase: nx.phase, cycle: nx.cycle, status: 'running', endsAt: Date.now() + full, remainingMs: full });
  } else {
    pomoStore.set({ phase: nx.phase, cycle: nx.cycle, status: 'idle', endsAt: 0, remainingMs: full });
  }
}

export function initPomodoro(host: HTMLElement, hooks: PomoHooks) {
  const notifyPhase = (completed: PomoPhase) => {
    const s = pomoStore.get();
    if (!s.settings.notify && !s.settings.sound) return;
    const mins = (p: PomoPhase) => (p === 'focus' ? s.settings.focusMin : p === 'short' ? s.settings.shortMin : s.settings.longMin);
    const nx = pomoNext(completed, s.cycle, s.settings.cycles);
    const title = completed === 'focus' ? 'Pomodoro — focus complete' : 'Pomodoro — break over';
    const body = completed === 'focus'
      ? `Time for a ${nx.phase === 'long' ? 'long' : 'short'} break (${mins(nx.phase)}m).`
      : `Ready for focus session ${nx.cycle + 1}? (${mins('focus')}m)`;
    if (s.settings.sound) {
      const gs = readSettings();
      void playNotificationSound(resolveSoundUrl(gs.notifSoundName, gs.notifCustomPath), gs.notifVolume / 100);
    }
    if (!s.settings.notify) return;
    if (!document.hasFocus()) {
      void barang().app.notify({ title, body, kind: 'info', badge: false }).catch(() => undefined);
    } else {
      hooks.toast(`${title.replace('Pomodoro — ', '')}: ${body}`, 'info');
    }
  };
  ensureLoop(notifyPhase);

  const wrap = el('div', { class: 'pomo' });
  host.append(wrap);

  const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ringSvg.setAttribute('class', 'pomo-ring');
  ringSvg.setAttribute('viewBox', '0 0 128 128');
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', '64');
  track.setAttribute('cy', '64');
  track.setAttribute('r', String(RING_R));
  track.setAttribute('class', 'pomo-ring-track');
  const prog = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  prog.setAttribute('cx', '64');
  prog.setAttribute('cy', '64');
  prog.setAttribute('r', String(RING_R));
  prog.setAttribute('class', 'pomo-ring-prog');
  ringSvg.append(track, prog);
  const clock = el('div', { class: 'pomo-clock' }, '25:00');
  const phaseEl = el('div', { class: 'pomo-phase' }, 'Focus');
  const ringWrap = el('div', { class: 'pomo-ring-wrap' });
  const centerOv = el('div', { class: 'pomo-center' });
  centerOv.append(clock, phaseEl);
  ringWrap.append(ringSvg, centerOv);
  const dots = el('div', { class: 'pomo-dots' });
  const btnRow = el('div', { class: 'pomo-btns' });
  wrap.append(ringWrap, dots, btnRow);

  const secTitle = el('div', { class: 'pomo-sec-title' }, 'Settings');
  wrap.append(secTitle);
  const settingsBox = el('div', { class: 'pomo-settings' });
  wrap.append(settingsBox);
  wrap.append(el('p', { class: 'settings-note' }, 'Changes apply to upcoming phases — the running one keeps its length.'));

  const commitSettings = (mut: (s: PomoSettings) => void) => {
    const next = readPomoSettings();
    mut(next);
    writePomoSettings(next);
    const cur = pomoStore.get();
    pomoStore.set({
      settings: next,
      remainingMs: cur.status === 'idle' ? pomoDurationMs(next, cur.phase) : cur.remainingMs,
    });
  };

  const stepper = (label: string, unit: string, get: (s: PomoSettings) => number, set: (s: PomoSettings, v: number) => void, min: number, max: number, step: number) => {
    const row = el('div', { class: 'pomo-row' });
    row.append(el('span', { class: 'settings-row-label' }, label));
    const ctl = el('span', { class: 'pomo-stepper' });
    const val = el('span', { class: 'pomo-step-val' }, '');
    const minus = el('button', { class: 'btn btn-sm pomo-step-btn', title: `Less ${label.toLowerCase()}` }, '−') as HTMLButtonElement;
    const plus = el('button', { class: 'btn btn-sm pomo-step-btn', title: `More ${label.toLowerCase()}` }, '+') as HTMLButtonElement;
    minus.onclick = () => commitSettings((s) => set(s, Math.max(min, get(s) - step)));
    plus.onclick = () => commitSettings((s) => set(s, Math.min(max, get(s) + step)));
    const paint = (s: PomoSettings) => {
      val.textContent = `${get(s)}${unit}`;
      minus.toggleAttribute('disabled', get(s) <= min);
      plus.toggleAttribute('disabled', get(s) >= max);
    };
    ctl.append(minus, val, plus);
    row.append(ctl);
    return { row, paint };
  };

  const toggleRow = (label: string, get: (s: PomoSettings) => boolean, set: (s: PomoSettings, v: boolean) => void, hint?: string) => {
    const lab = el('label', { class: 'settings-check' }) as HTMLLabelElement;
    const input = el('input', { class: 'switch-input', type: 'checkbox' }) as HTMLInputElement;
    const trackEl = el('span', { class: 'switch-track' });
    trackEl.append(el('span', { class: 'switch-thumb' }));
    lab.append(input, el('span', { class: 'settings-check-label' }, label), trackEl);
    input.onchange = () => commitSettings((s) => set(s, input.checked));
    const box = el('div', {});
    box.append(lab);
    if (hint) box.append(el('p', { class: 'settings-note' }, hint));
    return { box, paint: (s: PomoSettings) => { input.checked = get(s); } };
  };

  const stepFocus = stepper('Focus length', 'm', (s) => s.focusMin, (s, v) => { s.focusMin = v; }, 1, 180, 5);
  const stepShort = stepper('Short break', 'm', (s) => s.shortMin, (s, v) => { s.shortMin = v; }, 1, 60, 1);
  const stepLong = stepper('Long break', 'm', (s) => s.longMin, (s, v) => { s.longMin = v; }, 1, 90, 5);
  const stepCycles = stepper('Long break every', '', (s) => s.cycles, (s, v) => { s.cycles = v; }, 1, 12, 1);
  const togBreaks = toggleRow('Auto-start breaks', (s) => s.autoBreaks, (s, v) => { s.autoBreaks = v; }, 'Begin rest phases without asking.');
  const togFocus = toggleRow('Auto-start focus', (s) => s.autoFocus, (s, v) => { s.autoFocus = v; }, 'Begin work phases without asking.');
  const togNotify = toggleRow('Notifications', (s) => s.notify, (s, v) => { s.notify = v; }, 'Toast when a phase ends.');
  const togSound = toggleRow('Sound', (s) => s.sound, (s, v) => { s.sound = v; }, 'Play the notification sound.');
  settingsBox.append(
    stepFocus.row, stepShort.row, stepLong.row, stepCycles.row,
    togBreaks.box, togFocus.box, togNotify.box, togSound.box,
  );

  const paint = () => {
    const s = pomoStore.get();
    const total = pomoDurationMs(s.settings, s.phase);
    const frac = s.status === 'idle' && s.remainingMs >= total ? 0 : 1 - Math.max(0, Math.min(1, s.remainingMs / total));
    prog.style.strokeDasharray = `${RING_C}`;
    prog.style.strokeDashoffset = `${RING_C * (1 - frac)}`;
    (prog.style as CSSStyleDeclaration).stroke = PHASE_COLOR[s.phase];
    clock.textContent = formatClock(s.remainingMs);
    phaseEl.textContent = s.status === 'paused' ? `Paused — ${PHASE_LABEL[s.phase]}` : PHASE_LABEL[s.phase];
    ringWrap.title = `${PHASE_LABEL[s.phase]} — ${formatClock(s.remainingMs)}${s.status === 'running' ? ' (running)' : s.status === 'paused' ? ' (paused)' : ''}`;
    // Cycle dots.
    dots.innerHTML = '';
    const filled = pomoDotsFilled(s.cycle, s.settings.cycles);
    for (let i = 0; i < s.settings.cycles; i++) {
      dots.append(el('span', { class: `pomo-dot${i < filled ? ' done' : ''}${s.status === 'running' && s.phase === 'focus' && i === filled ? ' now' : ''}` }));
    }
    // Transport buttons per state.
    btnRow.innerHTML = '';
    const mk = (label: string, cls: string, fn: () => void, primary = false) => {
      const b = el('button', { class: `btn btn-sm ${cls}`, title: label }) as HTMLButtonElement;
      b.textContent = label;
      if (primary) b.classList.add('btn-primary');
      b.onclick = fn;
      return b;
    };
    if (s.status === 'running') {
      btnRow.append(
        mk('Pause', '', () => pomoStore.set({ status: 'paused', remainingMs: Math.max(0, s.endsAt - Date.now()), endsAt: 0 })),
        mk('Reset', '', () => pomoStore.set({ status: 'idle', phase: 'focus', cycle: 0, endsAt: 0, remainingMs: pomoDurationMs(s.settings, 'focus') })),
        mk('Skip', '', () => finishPhase(() => {}, true)),
      );
    } else if (s.status === 'paused') {
      btnRow.append(
        mk('Resume', '', () => {
          const cur = pomoStore.get();
          pomoStore.set({ status: 'running', endsAt: Date.now() + cur.remainingMs });
        }, true),
        mk('Reset', '', () => pomoStore.set({ status: 'idle', phase: 'focus', cycle: 0, endsAt: 0, remainingMs: pomoDurationMs(s.settings, 'focus') })),
        mk('Skip', '', () => finishPhase(() => {}, true)),
      );
    } else {
      btnRow.append(mk(s.cycle > 0 || s.remainingMs < total ? 'Continue' : 'Start', '', () => {
        const cur = pomoStore.get();
        const full = cur.remainingMs > 0 && cur.remainingMs < total ? cur.remainingMs : total;
        pomoStore.set({ status: 'running', endsAt: Date.now() + full, remainingMs: full });
      }, true));
      if (s.cycle > 0 || s.remainingMs < total) {
        btnRow.append(mk('Reset', '', () => pomoStore.set({ status: 'idle', phase: 'focus', cycle: 0, endsAt: 0, remainingMs: pomoDurationMs(s.settings, 'focus') })));
      }
    }
    stepFocus.paint(s.settings);
    stepShort.paint(s.settings);
    stepLong.paint(s.settings);
    stepCycles.paint(s.settings);
    togBreaks.paint(s.settings);
    togFocus.paint(s.settings);
    togNotify.paint(s.settings);
    togSound.paint(s.settings);
  };
  pomoStore.subscribe(paint);
  paint();
  return {};
}
