/**
 * Shared directory-watch trigger for daemon channels backed by files.
 *
 * State-like files in kobe are commonly written with tmp+rename. Watching the
 * file inode directly goes stale after the first rename, so daemon fan-out
 * modules watch the parent directory, filter by filename, debounce bursts, and
 * optionally poll as a safety net. This module owns those mechanics; callers
 * provide only the file path and the action to run when it changes.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs"
import { basename, dirname } from "node:path"

export interface FileWatchTriggerOptions {
  /** File whose parent directory should be watched. */
  readonly filePath: string
  /** Additional basenames that should count as the same watched file. */
  readonly matchBasenames?: readonly string[]
  /** Debounce between a matching fs event and `onTrigger`. `<= 0` disables. */
  readonly debounceMs: number
  /** Optional safety-net poll cadence. `<= 0` disables polling. */
  readonly pollMs?: number
  /** Called after a debounced matching event, and on each poll tick. */
  readonly onTrigger: () => void
  /** Best-effort error sink; trigger and watcher errors are never thrown. */
  readonly onError: (err: unknown) => void
}

/**
 * Start a best-effort watcher. The returned stop function closes the watcher
 * and clears any pending debounce/poll timers.
 */
export function startFileWatchTrigger(opts: FileWatchTriggerOptions): () => void {
  if (opts.debounceMs <= 0) return () => {}

  const dir = dirname(opts.filePath)
  const names = new Set([basename(opts.filePath), ...(opts.matchBasenames ?? [])])

  let timer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null

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

  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, (_event, filename) => {
      const name = filename === null ? null : String(filename)
      if (name !== null && !names.has(name)) return
      schedule()
    })
    watcher.on("error", opts.onError)
  } catch (err) {
    opts.onError(err)
  }

  if (opts.pollMs && opts.pollMs > 0) {
    poll = setInterval(trigger, opts.pollMs)
    poll.unref?.()
  }

  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (poll) {
      clearInterval(poll)
      poll = null
    }
    watcher?.close()
    watcher = null
  }
}
