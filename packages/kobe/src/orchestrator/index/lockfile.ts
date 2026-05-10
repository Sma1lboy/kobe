/**
 * PID-based lockfile for the task index.
 *
 * Goal: prevent two kobe instances from racing to write `~/.kobe/tasks.json`
 * and corrupting it. We use the simplest mechanism that does the job:
 * an `O_EXCL` lockfile containing the holder's PID.
 *
 * Failure modes:
 *
 *   - **Holder is alive** — `acquire()` rejects. The other instance gets a
 *     clear "another kobe is running" error. (Higher layers can decide
 *     whether to retry or surface to the user.)
 *
 *   - **Holder crashed** (process gone, lockfile remains stale) — we
 *     test the recorded PID with `process.kill(pid, 0)` (signal 0 is
 *     "test only"). If it throws ESRCH, the holder is dead; we log a
 *     warning, remove the stale lockfile, and re-acquire.
 *
 *   - **Holder is a different program reusing the PID** — false positive,
 *     we'd wait forever. Acceptable: PID reuse on the same machine in
 *     the same minute is rare, and the cost of a false negative (corrupted
 *     index) is much worse than the cost of a false positive (kobe refuses
 *     to start, user kills the lockfile manually).
 *
 * Not goals: cross-machine locking (NFS-safe), advisory POSIX locks
 * (flock — Bun coverage uneven), retry/backoff (caller's choice).
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface LockfileOptions {
  /**
   * If the holder PID is alive, should we steal anyway? Default false.
   * Used by tests that want to bypass the live-process check.
   */
  readonly forceTakeover?: boolean
}

/**
 * Check whether a process exists. `process.kill(pid, 0)` is the standard
 * trick: signal 0 doesn't actually send a signal, it just performs the
 * permission/existence check.
 *
 * - alive → returns
 * - dead (ESRCH) → throws Error{code: "ESRCH"}
 * - permission denied (EPERM) → throws; we treat this as "alive" because
 *   the process exists, we just can't signal it.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    // EPERM means the process exists but we can't signal it — count as alive.
    return true
  }
}

export class LockfileError extends Error {
  readonly heldByPid: number
  constructor(message: string, heldByPid: number) {
    super(message)
    this.name = "LockfileError"
    this.heldByPid = heldByPid
  }
}

/**
 * Acquire an exclusive lock at `lockPath`. The file's contents are this
 * process's PID, so a future kobe can decide whether to take over.
 *
 * Throws {@link LockfileError} if the lock is held by a live process.
 */
export async function acquire(lockPath: string, opts: LockfileOptions = {}): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true })

  // Fast path: O_EXCL create. If it succeeds we own the lock.
  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" })
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err
    }
  }

  // Slow path: lock exists. Inspect the holder.
  let holderPid = -1
  try {
    const raw = (await readFile(lockPath, "utf8")).trim()
    holderPid = Number.parseInt(raw, 10)
    if (!Number.isFinite(holderPid)) holderPid = -1
  } catch {
    // Lockfile vanished between our EEXIST and the read. Retry once.
    return acquire(lockPath, opts)
  }

  const alive = holderPid > 0 && isProcessAlive(holderPid)
  if (alive && !opts.forceTakeover) {
    throw new LockfileError(`task index is locked by another kobe instance (pid ${holderPid})`, holderPid)
  }

  // Stale (or stolen): remove and re-create with our pid.
  // We log to stderr so the user sees the takeover happen — silent
  // takeovers are scary in concurrent contexts.
  console.warn(
    `[kobe] removing stale lockfile at ${lockPath} (was held by pid ${holderPid}` +
      `${alive ? ", forced" : ", process gone"})`,
  )
  try {
    await unlink(lockPath)
  } catch (err) {
    // Race: another acquirer also unlinked. EEXIST or ENOENT both fine here.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
  // One more attempt. If we still lose, surface the error.
  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Someone else won the takeover race. Read their pid and report.
      let winnerPid = -1
      try {
        winnerPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10)
      } catch {
        winnerPid = -1
      }
      throw new LockfileError(`task index lockfile contended during takeover (winner pid ${winnerPid})`, winnerPid)
    }
    throw err
  }
}

/**
 * Release the lock. Tolerant of "already gone" — we don't want a missing
 * lockfile during shutdown to mask a more interesting error.
 */
export async function release(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    throw err
  }
}
