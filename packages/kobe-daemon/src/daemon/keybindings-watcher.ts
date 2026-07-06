import { homedir } from "node:os"
import { basename, join } from "node:path"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { startFileWatchTrigger } from "./file-watch-trigger.ts"

export const DEFAULT_KEYBINDINGS_DEBOUNCE_MS = 200

export function defaultKeybindingsPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "settings", "keybindings.yaml")
}

export interface KeybindingsWatcherOptions {
  readonly path?: string
  readonly debounceMs?: number
}

export function startKeybindingsWatcher(bus: DaemonEventBus, options: KeybindingsWatcherOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_KEYBINDINGS_DEBOUNCE_MS
  if (debounceMs <= 0) return () => {}
  const filePath = options.path ?? defaultKeybindingsPath()
  const baseYaml = basename(filePath)
  const baseYml = baseYaml.replace(/\.yaml$/, ".yml")

  let rev = 0
  bus.publish("keybindings", { rev })

  const bump = (): void => {
    try {
      rev += 1
      bus.publish("keybindings", { rev })
    } catch (err) {
      logDaemonError("keybindings-watcher", err)
    }
  }

  return startFileWatchTrigger({
    filePath,
    matchBasenames: [baseYaml, baseYml],
    debounceMs,
    onTrigger: bump,
    onError: (err) => logDaemonError("keybindings-watcher", err),
  })
}
