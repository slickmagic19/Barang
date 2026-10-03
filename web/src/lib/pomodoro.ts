// Pomodoro engine: pure phase math + persisted settings + a tiny store.
// The wall-clock loop lives in ui/pomodoro (interval + notifications); every
// decision below is unit-probed in smoke.
import { createStore } from './util';

export type PomoPhase = 'focus' | 'short' | 'long';
export type PomoStatus = 'idle' | 'running' | 'paused';

export interface PomoSettings {
  focusMin: number; // 1-180
  shortMin: number; // 1-60
  longMin: number; // 1-90
  cycles: number; // focus sessions per long break, 1-12
  autoBreaks: boolean; // start breaks without asking
  autoFocus: boolean; // start focus without asking after a break
  notify: boolean; // toast on phase change
  sound: boolean; // sound on phase change
}

export const POMO_DEFAULTS: PomoSettings = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  cycles: 4,
  autoBreaks: true,
  autoFocus: false,
  notify: true,
  sound: true,
};

const KEY = 'barang:pomodoro-v1';

const clampInt = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
};

/** Validated settings (stored or defaults). Pure. */
export function normalizePomoSettings(p: Partial<PomoSettings> | null | undefined): PomoSettings {
  const q = (p ?? {}) as Record<string, unknown>;
  return {
    focusMin: clampInt(q.focusMin, 1, 180, POMO_DEFAULTS.focusMin),
    shortMin: clampInt(q.shortMin, 1, 60, POMO_DEFAULTS.shortMin),
    longMin: clampInt(q.longMin, 1, 90, POMO_DEFAULTS.longMin),
    cycles: clampInt(q.cycles, 1, 12, POMO_DEFAULTS.cycles),
    autoBreaks: q.autoBreaks !== false,
    autoFocus: q.autoFocus === true,
    notify: (q as { notify?: unknown }).notify !== false,
    sound: (q as { sound?: unknown }).sound !== false,
  };
}

export function readPomoSettings(): PomoSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...POMO_DEFAULTS };
    return normalizePomoSettings(JSON.parse(raw) as Partial<PomoSettings>);
  } catch {
    return { ...POMO_DEFAULTS };
  }
}

export function writePomoSettings(s: PomoSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizePomoSettings(s)));
  } catch { /* private mode */ }
}

/** Phase duration in ms. Pure. */
export function pomoDurationMs(s: PomoSettings, phase: PomoPhase): number {
  const mins = phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin;
  return Math.max(60000, mins * 60000);
}

/** Next phase after one completes. cycle = completed focus sessions in this
 *  set (bumped when a focus ends). Pure. */
export function pomoNext(phase: PomoPhase, cycle: number, cycles: number): { phase: PomoPhase; cycle: number } {
  const every = Math.max(1, Math.floor(cycles) || 4);
  if (phase !== 'focus') return { phase: 'focus', cycle };
  const done = cycle + 1;
  return { phase: done % every === 0 ? 'long' : 'short', cycle: done };
}

/** Clock text for a remaining-ms count. Pure. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface PomoState {
  phase: PomoPhase;
  status: PomoStatus;
  endsAt: number; // epoch ms when a running phase completes
  remainingMs: number; // paused/idle remainder (or full length when idle)
  cycle: number; // completed focus sessions in this set
  settings: PomoSettings;
}

export const pomoStore = createStore<PomoState>({
  phase: 'focus',
  status: 'idle',
  endsAt: 0,
  remainingMs: POMO_DEFAULTS.focusMin * 60000,
  cycle: 0,
  settings: readPomoSettings(),
});

/** Reload persisted settings into the store (called on view open). */
export function reloadPomoSettings() {
  const settings = readPomoSettings();
  const s = pomoStore.get();
  pomoStore.set({
    settings,
    remainingMs: s.status === 'idle' ? pomoDurationMs(settings, s.phase) : s.remainingMs,
  });
}
