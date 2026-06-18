/**
 * Daemon-side watcher for the user keybindings file
 * (`~/.kobe/settings/keybindings.yaml`) — the second live-prefs fan-out,
 * sibling to `ui-prefs-watcher.ts`.
 *
 * The TUI applies keybinding overrides ONCE at boot (`applyUserKeybindings`
 * onto the in-memory `KobeKeymap`), so editing the YAML used to require a
 * full session rebuild before any pane saw the new chords. This watcher
 * makes the daemon the cross-session trigger: watch the file and publish a
 * monotonically-bumping `rev` on the `keybindings` channel. A pane doesn't
 * need the file CONTENT from us — it re-reads + re-applies the file itself
 * (it owns the keymap registry); the channel is purely the "re-read now"
 * ping, fanned out to every session at once.
 *
 * The watch mechanics mirror `ui-prefs-watcher.ts` exactly (watch the
 * DIRECTORY so an editor's tmp+rename doesn't kill an inode-bound file
 * watch; debounce a write burst; best-effort, never fatal). The one
 * difference: there's no "changed-only" compare — any touch of the file
 * bumps the rev, because the daemon deliberately doesn't parse the YAML
 * (the TUI owns validation). A no-op edit costing one harmless re-apply in
 * each pane is the accepted trade for keeping the daemon keymap-neutral.
 */

import { homedir } from "node:os"
import { basename, join } from "node:path"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { startFileWatchTrigger } from "./file-watch-trigger.ts"

/** Default debounce between a file event and the rev bump+publish. */
export const DEFAULT_KEYBINDINGS_DEBOUNCE_MS = 200

/**
 * Path of the user keybindings file for a kobe home. Mirrors
 * `keybindingsConfigPath()` in `packages/kobe/src/env.ts` (keep in sync):
 * `<home>/.kobe/settings/keybindings.yaml`. The `.yml` spelling is also
 * honoured — the watch is on the directory, so both filenames match.
 */
export function defaultKeybindingsPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "settings", "keybindings.yaml")
}

export interface KeybindingsWatcherOptions {
  /** Keybindings file path to watch. Defaults to {@link defaultKeybindingsPath}. */
  readonly path?: string
  /**
   * Debounce between a file event and the publish. `<= 0` disables the
   * watcher entirely (returns a no-op stop, publishes nothing) — the same
   * disable convention as the server's other pollers.
   */
  readonly debounceMs?: number
}

/**
 * Start the watcher: publish an initial `rev` (replay seed, so a late
 * subscriber learns the channel exists), then bump+publish after every
 * debounced file event. Returns a `stop()` that closes the fs watcher and
 * clears any pending debounce.
 */
export function startKeybindingsWatcher(bus: DaemonEventBus, options: KeybindingsWatcherOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_KEYBINDINGS_DEBOUNCE_MS
  if (debounceMs <= 0) return () => {}
  const filePath = options.path ?? defaultKeybindingsPath()
  // Match both the canonical `.yaml` and the `.yml` fallback spelling.
  const baseYaml = basename(filePath)
  const baseYml = baseYaml.replace(/\.yaml$/, ".yml")

  // A monotonically-increasing revision. The value is meaningless on its
  // own — only its CHANGES matter to a pane (each bump = "re-read"). The
  // initial publish seeds the bus last-value cache for replay.
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

  // No watcher → panes keep the keybindings they read at boot (the documented
  // degraded mode). The initial publish above still seeds the channel.
  return startFileWatchTrigger({
    filePath,
    matchBasenames: [baseYaml, baseYml],
    debounceMs,
    onTrigger: bump,
    onError: (err) => logDaemonError("keybindings-watcher", err),
  })
}
