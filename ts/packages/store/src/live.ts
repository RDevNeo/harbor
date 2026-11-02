/** A copy's turn as its home PC last said it (net's replica). */
export interface CopyTurn {
  running: boolean;
  sinceMs: number | null;
}

/** When the chat's turn started wherever it runs: this PC's turn, else its home PC's word for a copy; null while none runs. */
export function liveSince(here: number | null, copy: CopyTurn | null | undefined, now: () => number = Date.now): number | null {
  if (here !== null) return here;
  // A home PC older than since_ms says only that it runs.
  return copy?.running ? (copy.sinceMs ?? now()) : null;
}
