// Agent notifications: edge detection over agentStore, sound playback with
// autoplay-unlock, and a single wiring point for the app shell.
// Sounds are 100% original synth WAVs shipped in web/public/sounds (Pixabay
// blocks programmatic downloads, so nothing is vendored from there).
import { agentStore } from './agent';
import { barang } from './transport';

export type NotifyKind = 'done' | 'approval' | 'error';

export interface BuiltinSound {
  id: string;
  label: string;
  file: string; // bundled path, relative to the built index.html
}

export const BUILTIN_SOUNDS: BuiltinSound[] = [
  { id: 'chime', label: 'Chime', file: 'sounds/chime.wav' },
  { id: 'ding', label: 'Ding', file: 'sounds/ding.wav' },
  { id: 'pop', label: 'Pop', file: 'sounds/pop.wav' },
  { id: 'alert', label: 'Alert', file: 'sounds/alert.wav' },
  { id: 'success', label: 'Success', file: 'sounds/success.wav' },
];

export interface AgentSnap {
  root: string;
  busy: boolean;
  error: string | null;
  perms: number;
  questions: number;
  activeId: string | null;
}

/** Pure edge detector (unit-verified in smoke): prev -> next yields at most one event. */
export function decideAgentNotification(prev: AgentSnap, next: AgentSnap): NotifyKind | null {
  if (next.root !== prev.root) return null; // project switch, not a run edge
  if (next.activeId !== prev.activeId && next.activeId !== null && prev.activeId !== null) return null; // session switch
  if (next.error && next.error !== prev.error) return 'error';
  // Approval/question waits happen mid-run (busy stays true) — fire on
  // arrival and when a run ends with asks still pending, not only when idle.
  const waiting = (s: AgentSnap) => s.perms + s.questions;
  if (waiting(next) > waiting(prev) || (prev.busy && !next.busy && waiting(next) > 0)) return 'approval';
  if (prev.busy && !next.busy && next.activeId && !next.error && waiting(next) === 0) return 'done';
  return null;
}

export function snapAgent(): AgentSnap {
  const a = agentStore.get();
  return { root: a.root, busy: a.busy, error: a.error, perms: a.permissions.length, questions: a.questions.length, activeId: a.activeId };
}

export function watchAgentNotifications(onEvent: (kind: NotifyKind) => void): () => void {
  let last = snapAgent();
  return agentStore.subscribe(() => {
    const next = snapAgent();
    const kind = decideAgentNotification(last, next);
    last = next;
    if (kind) {
      try {
        onEvent(kind);
      } catch {
        /* a broken handler must never break the agent loop */
      }
    }
  });
}

// --- sound playback ----------------------------------------------------------
// Chromium blocks Audio before any user gesture: prime on the first
// interaction, and if a play is still refused, replay it on the next gesture.
let audioPrimed = false;
let pendingReplay: { url: string; volume: number } | null = null;

function primeAudio() {
  if (audioPrimed) return;
  audioPrimed = true;
  if (pendingReplay) {
    const p = pendingReplay;
    pendingReplay = null;
    void playUrl(p.url, p.volume);
  }
}

export function armAudioUnlock() {
  const unlock = () => primeAudio();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

async function playUrl(url: string, volume: number): Promise<boolean> {
  try {
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    await a.play();
    return true;
  } catch {
    if (!audioPrimed) pendingReplay = { url, volume };
    return false;
  }
}

/** Play a notification sound URL (bundled or custom file://). False = blocked/failed. */
export function playNotificationSound(url: string | null, volume: number): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  return playUrl(url, volume);
}

/** Resolve the configured sound to a playable URL (custom falls back to chime). */
export function resolveSoundUrl(soundName: string, customPath: string): string | null {
  if (soundName === 'custom' && customPath) return customPath;
  const hit = BUILTIN_SOUNDS.find((s) => s.id === soundName) ?? BUILTIN_SOUNDS[0];
  return hit.file;
}

export interface CustomSoundEntry {
  id: string;
  name: string;
  fileUrl: string;
}

/** Per-kind fallback when the pick is missing/invalid. */
export const KIND_DEFAULT_SOUND: Record<NotifyKind, string> = {
  done: 'success',
  approval: 'chime',
  error: 'alert',
};

/** Resolve one kind's pick (builtin id or 'custom:<vaultId>') to a playable
 *  URL. Missing customs and unknown ids fall back to the kind default —
 *  a removed custom never silences notifications. Pure. */
export function resolveKindSound(
  kind: NotifyKind,
  picks: { done: string; approval: string; error: string },
  customs: CustomSoundEntry[],
): string | null {
  const raw = kind === 'done' ? picks.done : kind === 'approval' ? picks.approval : picks.error;
  const fallback = BUILTIN_SOUNDS.find((s) => s.id === KIND_DEFAULT_SOUND[kind]) ?? BUILTIN_SOUNDS[0];
  if (raw.startsWith('custom:')) {
    const hit = (customs ?? []).find((c) => c.id === raw.slice('custom:'.length));
    if (hit?.fileUrl) return hit.fileUrl;
    return fallback.file;
  }
  return (BUILTIN_SOUNDS.find((s) => s.id === raw) ?? fallback).file;
}

/** Session title for notification bodies (best effort). */
export function activeSessionTitle(): string | null {
  const a = agentStore.get();
  const s = a.sessions.find((x) => x.id === a.activeId);
  return s?.title ?? null;
}
