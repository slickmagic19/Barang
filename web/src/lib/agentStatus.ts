// Pure status-line helpers for the chat busy row. Kept out of agent.ts so the
// wording can be unit-tested without pulling in the transport/DOM layers.

/** Human status line for the busy row: 'retry' carries the attempt number,
 *  everything else is the plain working label. The row already animates a
 *  spinner, so no extra "(busy)" suffix or dots are added here. Pure. */
export function statusTextFor(status: string, attempt = 0): string {
  if (status === 'retry') return attempt > 0 ? `Agent retrying… (attempt ${attempt})` : 'Agent retrying…';
  if (status === 'stopping') return 'Agent stopping…';
  return 'Agent working…';
}
