/**
 * Shared directory-watch trigger for daemon channels backed by files.
 *
 * State-like files in kobe are commonly written with tmp+rename. Watching the
 * file inode directly goes stale after the first rename, so daemon fan-out
 * modules watch the parent directory, filter by filename, and debounce bursts.
 * This module owns those mechanics; callers provide only the file path and the
 * action to run when it changes.
 *
 * The watcher is backed by chokidar, which already smooths over the
 * cross-platform fs-event edge cases (macOS rename/inode churn, rapid bursts,
 * atomic saves) that previously needed a hand-rolled polling safety-net.
 */

import { mkdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { type FSWatcher, watch } from "chokidar"

export interface FileWatchTriggerOptions {
  /** File whose parent directory should be watched. */
  readonly filePath: string
  /** Additional basenames that should count as the same watched file. */
  readonly matchBasenames?: readonly string[]
  /** Debounce between a matching fs event and `onTrigger`. `<= 0` disables. */
  readonly debounceMs: number
  /**
   * @deprecated Retained for caller/source compatibility only. chokidar's
   * cross-platform watcher replaces the old bespoke poll safety-net, so this
   * field is now ignored.
   */
  readonly pollMs?: number
  /** Called after a debounced matching event. */
  readonly onTrigger: () => void
  /** Best-effort error sink; trigger and watcher errors are never thrown. */
  readonly onError: (err: unknown) => void
}

/**
 * Start a best-effort watcher. The returned stop function closes the chokidar
 * watcher and clears any pending debounce timer.
 */
export function startFileWatchTrigger(opts: FileWatchTriggerOptions): () => void {
  if (opts.debounceMs <= 0) return () => {}

  const dir = dirname(opts.filePath)
  const names = new Set([basename(opts.filePath), ...(opts.matchBasenames ?? [])])

  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  let stopped = false

  const trigger = (): void => {
    try {
      opts.onTrigger()
    } catch (err) {
      opts.onError(err)
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      trigger()
    }, opts.debounceMs)
    timer.unref?.()
  }

  const onPath = (changedPath: string): void => {
    if (!names.has(basename(changedPath))) return
    schedule()
  }

  // Per-file signature (mtime+size, or null if absent) used to detect any write
  // that lands while chokidar is still arming its underlying directory watch.
  const sigOf = (name: string): string | null => {
    try {
      const s = statSync(join(dir, name))
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return null
    }
  }

  try {
    mkdirSync(dir, { recursive: true })
    // chokidar arms its directory watch ASYNCHRONOUSLY (after a readdir scan),
    // whereas the old fs.watch armed synchronously. Snapshot the watched files
    // NOW so the one-shot `ready` reconciliation below can catch any write that
    // slips through that arm window — closing the startup race without a
    // recurring poll.
    const startSigs = new Map<string, string | null>()
    for (const name of names) startSigs.set(name, sigOf(name))

    watcher = watch(dir, {
      // We diff by basename ourselves and only want this one directory.
      depth: 0,
      // The directory already exists; don't fire for files present at start.
      ignoreInitial: true,
    })
    watcher.on("add", onPath)
    watcher.on("change", onPath)
    watcher.on("unlink", onPath)
    watcher.on("error", opts.onError)
    watcher.once("ready", () => {
      // If a matching file changed between start and arm, fire once to catch up.
      for (const name of names) {
        if (sigOf(name) !== startSigs.get(name)) {
          schedule()
          break
        }
      }
    })
  } catch (err) {
    opts.onError(err)
  }

  return () => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const w = watcher
    watcher = null
    // close() is async; swallow rejection so teardown stays best-effort and
    // never throws into the caller's stop path.
    void w?.close().catch(opts.onError)
  }
}
