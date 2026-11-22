// Sessions the app creates for background work (memory extraction). Their
// events must never surface approval/question cards in the user's panel — a
// hidden session asking something would block the shell for app-internal work.
const hiddenSessionIds = new Set<string>();

/** Mark a session as app-internal so its events stay out of the UI. */
export function registerHiddenSession(id: string): void {
  if (id) hiddenSessionIds.add(id);
}

/** Drop a hidden session from the registry after it is deleted. */
export function forgetHiddenSession(id: string): void {
  hiddenSessionIds.delete(id);
}

export function isHiddenSession(id: string | null | undefined): boolean {
  return !!id && hiddenSessionIds.has(String(id));
}
