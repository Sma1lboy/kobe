import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { startFileWatchTrigger } from "./file-watch-trigger.ts"
import type { UiPrefsPayload } from "./protocol.ts"

export const DEFAULT_UI_PREFS_DEBOUNCE_MS = 200

export const DEFAULT_UI_PREFS_POLL_MS = 250

const FOCUS_ACCENT_SLOT_NAMES = ["primary", "success", "info"] as const

export function defaultUiPrefsStatePath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".config", "kobe", "state.json")
}

export function readUiPrefsFromStateFile(statePath: string): UiPrefsPayload {
  let parsed: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
  } catch {}
  const theme = typeof parsed.activeTheme === "string" && parsed.activeTheme.length > 0 ? parsed.activeTheme : "claude"
  const transparentBackground = parsed.transparentBackground === true
  const focusAccent =
    typeof parsed.focusAccent === "string" &&
    (FOCUS_ACCENT_SLOT_NAMES as readonly string[]).includes(parsed.focusAccent)
      ? parsed.focusAccent
      : null
  const sortMode = parsed.activeSortMode === "recent" ? "recent" : "default"
  const keysCollapsed = parsed["tasksPane.keysCollapsed"] === true
  const projectFilter =
    typeof parsed["tasksPane.projectFilter"] === "string" && parsed["tasksPane.projectFilter"].length > 0
      ? parsed["tasksPane.projectFilter"]
      : null
  const locale = typeof parsed.locale === "string" && parsed.locale.length > 0 ? parsed.locale : "en"
  return { theme, transparentBackground, focusAccent, locale, sortMode, keysCollapsed, projectFilter }
}

function samePrefs(a: UiPrefsPayload, b: UiPrefsPayload): boolean {
  return (
    a.theme === b.theme &&
    a.transparentBackground === b.transparentBackground &&
    a.focusAccent === b.focusAccent &&
    a.locale === b.locale &&
    a.sortMode === b.sortMode &&
    a.keysCollapsed === b.keysCollapsed &&
    a.projectFilter === b.projectFilter
  )
}

export interface UiPrefsWatcherOptions {
  readonly statePath?: string
  readonly debounceMs?: number
  readonly pollMs?: number
}

export function startUiPrefsWatcher(bus: DaemonEventBus, options: UiPrefsWatcherOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_UI_PREFS_DEBOUNCE_MS
  if (debounceMs <= 0) return () => {}
  const pollMs = options.pollMs ?? DEFAULT_UI_PREFS_POLL_MS
  const statePath = options.statePath ?? defaultUiPrefsStatePath()
  const stateFile = basename(statePath)

  let last = readUiPrefsFromStateFile(statePath)
  bus.publish("ui-prefs", last)

  const publishIfChanged = (): void => {
    try {
      const next = readUiPrefsFromStateFile(statePath)
      if (samePrefs(last, next)) return
      last = next
      bus.publish("ui-prefs", next)
    } catch (err) {
      logDaemonError("ui-prefs-watcher", err)
    }
  }
  return startFileWatchTrigger({
    filePath: statePath,
    matchBasenames: [stateFile],
    debounceMs,
    pollMs,
    onTrigger: publishIfChanged,
    onError: (err) => logDaemonError("ui-prefs-watcher", err),
  })
}
