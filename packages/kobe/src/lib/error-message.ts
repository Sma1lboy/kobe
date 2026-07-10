/**
 * The message of an unknown thrown value — `Error#message` when it is a real
 * Error, else `String(err)`. The one shared spelling of a pattern that was
 * previously copied inline at ~50 call sites.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
