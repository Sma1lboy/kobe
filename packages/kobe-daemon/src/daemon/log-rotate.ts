/**
 * Size-capped rotation for kobe's append-only diagnostic logs
 * (`daemon.log`, `client.log`). Neither log had a cap before this — issue
 * #26: a daemon with dozens of orphan panes spamming reconnect-failure
 * lines forever grew `client.log` to 736MB and `daemon.log` to 345MB.
 *
 * One generation is kept (`<path>.old`), overwritten each rotation — this
 * is a debug trail, not an archive, so more generations just cost disk for
 * no benefit anyone has asked for.
 */

import { existsSync, renameSync, statSync } from "node:fs"

/** Default cap per log file. Generous enough that rotation is rare in
 *  normal use, tight enough that a runaway spam loop can't eat the disk. */
export const DEFAULT_LOG_ROTATE_CAP_BYTES = 10 * 1024 * 1024 // 10MB

/** Pure decision: should `sizeBytes` trigger a rotation? Extracted so the
 *  threshold logic is unit-testable without touching the filesystem. */
export function shouldRotateLog(sizeBytes: number, capBytes: number = DEFAULT_LOG_ROTATE_CAP_BYTES): boolean {
  return sizeBytes > capBytes
}

/**
 * If `path` exists and is over `capBytes`, rename it to `${path}.old`
 * (clobbering any previous `.old`) so the next write starts a fresh file.
 * Synchronous: callers use this at process-boot time, before any log
 * writer (or an inherited fd) opens the path, so there's no async window
 * where a write could land on the file mid-rename.
 *
 * Best-effort — a rotation failure (e.g. permission error) must never
 * block the caller from starting; swallow and continue on the un-rotated
 * file rather than throwing.
 */
export function rotateLogIfNeeded(path: string, capBytes: number = DEFAULT_LOG_ROTATE_CAP_BYTES): void {
  try {
    if (!existsSync(path)) return
    const { size } = statSync(path)
    if (!shouldRotateLog(size, capBytes)) return
    renameSync(path, `${path}.old`)
  } catch {
    /* best-effort — never block startup/writes over a rotation failure */
  }
}
