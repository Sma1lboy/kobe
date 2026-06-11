/**
 * Tail-truncate a path to fit a fixed-width slot: keep the END (the filename is
 * the useful part) and prefix an ellipsis. A path within the budget is returned
 * unchanged. Shared so the rail and the diff file list truncate identically.
 *
 * The result is at most `max` chars: the leading `…` plus the last `max - 1`.
 */
export function tailPath(path: string, max = 36): string {
  if (path.length <= max) return path
  return `…${path.slice(path.length - max + 1)}`
}
