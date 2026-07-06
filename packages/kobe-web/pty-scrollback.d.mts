/** Bounded scrollback ring for the PTY server (see pty-scrollback.mjs). */
export interface Scrollback {
  /** Append a chunk; drops whole chunks off the head once over cap. O(chunk). */
  push(data: string): void
  /** Flatten the retained chunks into one string (for a (re)attach replay). */
  replay(): string
  /** Retained length in string code units. */
  length(): number
  /** Number of retained chunks. */
  chunkCount(): number
}

/** Create a scrollback ring capped at `cap` string code units. */
export function createScrollback(cap: number): Scrollback
