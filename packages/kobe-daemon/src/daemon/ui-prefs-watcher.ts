/**
 * Daemon-side watcher for the persisted visual UI prefs (KOB — live theme
 * propagation).
 *
 * The theme / transparent-background / focus-accent prefs persist in the
 * shared KV blob (`~/.config/kobe/state.json`, written by the State Store
 * in `packages/kobe/src/state/store.ts`). Every pane host used to read
 * them ONCE at boot (`readPersistedUiPrefs`), so switching the theme in
 * one session's Settings left the Tasks/Ops panes of every OTHER task
 * session on the old theme forever. This module makes the daemon the
 * cross-session fan-out point: watch the state file, read the visual-pref
 * keys, and publish a `ui-prefs` channel payload that every subscribed
 * pane applies live.
 *
 * Watch mechanics — the parts that are load-bearing:
 *   - **Watch the DIRECTORY, not the file.** The State Store writes via
 *     tmp + rename, which swaps the file's inode — an `fs.watch` on the
 *     file itself goes dead after the first atomic write. Watching the
 *     parent dir and filtering on the filename survives every rename.
 *   - **Poll as a safety net.** Bun/macOS can miss that tmp+rename edge in
 *     a long-lived daemon even when the directory watch is alive. The state
 *     file is tiny and publishes are changed-only, so a low-frequency poll
 *     turns the live theme path from best-effort into reliable fan-out.
 *   - **Debounce.** A write burst (KVProvider flush + a `setPersisted*`
 *     call) collapses into one read ~{@link DEFAULT_UI_PREFS_DEBOUNCE_MS}
 *     later.
 *   - **Changed-only publish.** The state file carries many non-visual
 *     keys (saved repos, engine commands, notification toggles…); a write
 *     that didn't move the three visual prefs publishes nothing, so panes
 *     never re-apply on unrelated churn.
 *   - **Initial publish at start** warms the bus's last-value cache, so a
 *     late subscriber replays the current prefs on connect like any other
 *     state channel.
 *
 * Best-effort throughout: a missing/corrupt state file reads as defaults
 * (same policy as the State Store), and every failure is logged via
 * `logDaemonError("ui-prefs-watcher", …)` — never fatal to the daemon.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { startFileWatchTrigger } from "./file-watch-trigger.ts"
import type { UiPrefsPayload } from "./protocol.ts"

/** Default debounce between a state-file event and the read+publish. */
export const DEFAULT_UI_PREFS_DEBOUNCE_MS = 200

/** Safety-net poll cadence for missed fs.watch events. */
export const DEFAULT_UI_PREFS_POLL_MS = 250

/**
 * Focus-accent slots the TUI understands — mirror of `FOCUS_ACCENT_SLOTS`
 * in `packages/kobe/src/tui/context/theme.tsx`, not imported because that
 * module builds a Solid store on a renderer at load time and the daemon
 * must stay UI-free (same stance as `tui/lib/tmux-border-theme.ts`).
 */
const FOCUS_ACCENT_SLOT_NAMES = ["primary", "success", "info"] as const

/**
 * Path of the shared KV blob for a kobe home. Mirrors `kvStatePath()` in
 * `packages/kobe/src/env.ts` (keep in sync — same `defaultDaemonPidPath`
 * pattern as `daemon/paths.ts`): the daemon resolves it from the homeDir
 * the server was started with so sandbox/test homes stay isolated.
 */
export function defaultUiPrefsStatePath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".config", "kobe", "state.json")
}

/**
 * Read the visual-pref keys out of the state file. Never throws —
 * a missing / corrupt file yields the documented defaults (`claude`
 * theme, opaque, unset accent, `default` sort, expanded keys legend), the
 * same corrupt-file policy as the State Store and `readPersistedUiPrefs`.
 * The theme NAME is
 * passed through unvalidated (the daemon has no theme registry); the
 * TUI-side apply validates it against its own registry.
 */
export function readUiPrefsFromStateFile(statePath: string): UiPrefsPayload {
  let parsed: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
  } catch {
    // Missing or malformed state.json → defaults. Never surface — the
    // prefs channel must always have a sane value to replay.
  }
  const theme = typeof parsed.activeTheme === "string" && parsed.activeTheme.length > 0 ? parsed.activeTheme : "claude"
  const transparentBackground = parsed.transparentBackground === true
  const focusAccent =
    typeof parsed.focusAccent === "string" &&
    (FOCUS_ACCENT_SLOT_NAMES as readonly string[]).includes(parsed.focusAccent)
      ? parsed.focusAccent
      : null
  // Only `recent` is a non-default sort; any other / missing value is the
  // `default` ordering (the TUI's `TaskSortMode` union — kept in sync,
  // same UI-neutral mirror stance as the focus-accent slot list).
  const sortMode = parsed.activeSortMode === "recent" ? "recent" : "default"
  // Tasks-pane `── keys ──` legend fold (`?`); only an explicit `true`
  // collapses, anything else (missing / non-bool) is expanded.
  const keysCollapsed = parsed["tasksPane.keysCollapsed"] === true
  const projectFilter =
    typeof parsed["tasksPane.projectFilter"] === "string" && parsed["tasksPane.projectFilter"].length > 0
      ? parsed["tasksPane.projectFilter"]
      : null
  return { theme, transparentBackground, focusAccent, sortMode, keysCollapsed, projectFilter }
}

function samePrefs(a: UiPrefsPayload, b: UiPrefsPayload): boolean {
  return (
    a.theme === b.theme &&
    a.transparentBackground === b.transparentBackground &&
    a.focusAccent === b.focusAccent &&
    a.sortMode === b.sortMode &&
    a.keysCollapsed === b.keysCollapsed &&
    a.projectFilter === b.projectFilter
  )
}

export interface UiPrefsWatcherOptions {
  /** State-file path to watch. Defaults to {@link defaultUiPrefsStatePath}. */
  readonly statePath?: string
  /**
   * Debounce between a file event and the read+publish. `<= 0` disables
   * the watcher entirely (returns a no-op stop, publishes nothing) — the
   * same disable convention as the server's other pollers.
   */
  readonly debounceMs?: number
  /**
   * Poll fallback cadence in ms. `<= 0` disables only the fallback poll;
   * the directory watcher still runs. Defaults to
   * {@link DEFAULT_UI_PREFS_POLL_MS}.
   */
  readonly pollMs?: number
}

/**
 * Start the watcher: publish the current prefs immediately (replay seed),
 * then re-read + publish-on-change after every debounced state-file event
 * and on a small polling fallback. Returns a `stop()` that closes the fs
 * watcher and clears pending timers.
 */
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
  // No watcher → panes keep the boot-time prefs they read themselves (the
  // documented degraded mode). The initial publish above still serves the
  // at-start value to subscribers; the poll fallback continues when enabled.
  return startFileWatchTrigger({
    filePath: statePath,
    matchBasenames: [stateFile],
    debounceMs,
    pollMs,
    onTrigger: publishIfChanged,
    onError: (err) => logDaemonError("ui-prefs-watcher", err),
  })
}
