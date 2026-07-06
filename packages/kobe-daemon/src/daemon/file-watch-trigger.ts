import { mkdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { type FSWatcher, watch } from "chokidar"

export interface FileWatchTriggerOptions {
  readonly filePath: string
  readonly matchBasenames?: readonly string[]
  readonly debounceMs: number
  readonly pollMs?: number
  readonly onTrigger: () => void
  readonly onError: (err: unknown) => void
}

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
    const startSigs = new Map<string, string | null>()
    for (const name of names) startSigs.set(name, sigOf(name))

    watcher = watch(dir, {
      depth: 0,
      ignoreInitial: true,
    })
    watcher.on("add", onPath)
    watcher.on("change", onPath)
    watcher.on("unlink", onPath)
    watcher.on("error", opts.onError)
    watcher.once("ready", () => {
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
    void w?.close().catch(opts.onError)
  }
}
