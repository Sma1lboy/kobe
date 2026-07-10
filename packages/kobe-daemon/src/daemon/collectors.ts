/**
 * Background collectors/watchers the daemon runs while GUIs are attached —
 * the update poll, auto-title, ui-prefs/keybindings watchers, and the
 * worktree-changes / transcript-activity / pr-status collectors. Wired here
 * in one place so server.ts only decides WHEN they run (subscriber gating,
 * shutdown order); each collector's mechanics live in its own module.
 */

import type { Orchestrator } from "@/orchestrator/core"
import { type UpdateInfo, checkLatestVersion } from "@/version"
import { DEFAULT_AUTO_TITLE_POLL_MS, startAutoTitlePoller } from "./auto-title-poller.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import {
  DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  defaultKeybindingsPath,
  startKeybindingsWatcher,
} from "./keybindings-watcher.ts"
import { DEFAULT_PR_STATUS_POLL_MS, startPrStatusPoller } from "./pr-status-collector.ts"
import {
  DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
  startTranscriptActivityCollector,
} from "./transcript-activity-collector.ts"
import { DEFAULT_UI_PREFS_DEBOUNCE_MS, defaultUiPrefsStatePath, startUiPrefsWatcher } from "./ui-prefs-watcher.ts"
import { DEFAULT_WORKTREE_CHANGES_TICK_MS, startWorktreeChangesCollector } from "./worktree-changes-collector.ts"

/** How often the daemon re-checks npm for a newer kobe (6h — `latest` rarely moves). */
const DEFAULT_UPDATE_POLL_MS = 6 * 60 * 60 * 1000

/** The interval/debounce knobs of `DaemonServerOptions` the collectors read. */
export interface DaemonCollectorOptions {
  readonly homeDir?: string
  readonly checkUpdate?: () => Promise<UpdateInfo | null>
  readonly updatePollMs?: number
  readonly autoTitlePollMs?: number
  readonly prStatusPollMs?: number
  readonly uiPrefsDebounceMs?: number
  readonly keybindingsDebounceMs?: number
  readonly worktreeChangesTickMs?: number
  readonly transcriptActivityTickMs?: number
}

/**
 * Start every daemon-owned background collector. Returns a single `stop()`
 * that tears them down in the same order server.ts's `close()` historically
 * used. `hasSubscribers` gates the per-tick work of the pollers that would
 * otherwise burn CPU / network for nobody on a gui-less daemon.
 *
 * What each one is for:
 *   - update poll (KOB): poll npm once on start + on an interval and publish
 *     to the `update` channel, so every `kobe tasks` pane subscribes instead
 *     of hitting the registry itself. A failure is logged, not fatal; the bus
 *     caches the last value for late subscribers like any other channel.
 *   - auto-title (KOB): rename still-placeholder tasks from their engine
 *     transcript on an interval, so a name appears WHILE attached — the
 *     detach-time path in tui/direct.ts only fires on return. The rename
 *     broadcasts via the `task.snapshot` channel.
 *   - ui-prefs watcher (KOB — cross-session theme propagation): watch
 *     `state.json` for the theme / transparent / focus-accent keys and publish
 *     them on the `ui-prefs` channel, so every pane in EVERY task session
 *     re-applies a Settings appearance change live. The state path follows
 *     the same homeDir the server was started with, so sandbox/test homes
 *     isolate.
 *   - keybindings watcher (KOB — cross-session keybinding propagation):
 *     watch `~/.kobe/settings/keybindings.yaml` and ping the `keybindings`
 *     channel on change, so every pane re-reads + re-applies the file live.
 *   - worktree-changes collector (issue #6): the daemon runs the guarded
 *     `git status` polls for every non-archived local worktree and publishes
 *     the counts map on the `worktree.changes` channel, so panes render
 *     pushes instead of each spawning their own per-row git polls.
 *   - transcript-activity collector (perf): the daemon runs the guarded
 *     filesystem probes (newest transcript mtime + the engine-owned
 *     completion marker) and publishes on the `transcript.activity` channel;
 *     the per-window tmux quiescence check stays in-process (the daemon
 *     never touches tmux).
 *   - pr-status poller: shells `gh pr view` per task with a real branch and
 *     writes the result onto Task.prStatus, which rides the task push.
 */
export function startDaemonCollectors(
  orch: Orchestrator,
  bus: DaemonEventBus,
  hasSubscribers: () => boolean,
  options: DaemonCollectorOptions,
): () => void {
  const checkUpdate = options.checkUpdate ?? checkLatestVersion
  const updatePollMs = options.updatePollMs ?? DEFAULT_UPDATE_POLL_MS
  const pollUpdate = (): void => {
    void checkUpdate()
      .then((info) => bus.publish("update", { info }))
      .catch((err) => logDaemonError("update-poller", err))
  }
  let updateTimer: ReturnType<typeof setInterval> | null = null
  if (updatePollMs > 0) {
    pollUpdate()
    updateTimer = setInterval(pollUpdate, updatePollMs)
    updateTimer.unref?.()
  }

  const stopAutoTitlePoller = startAutoTitlePoller(
    orch,
    options.autoTitlePollMs ?? DEFAULT_AUTO_TITLE_POLL_MS,
    hasSubscribers,
  )

  const stopUiPrefsWatcher = startUiPrefsWatcher(bus, {
    statePath: defaultUiPrefsStatePath(options.homeDir),
    debounceMs: options.uiPrefsDebounceMs ?? DEFAULT_UI_PREFS_DEBOUNCE_MS,
  })

  const stopKeybindingsWatcher = startKeybindingsWatcher(bus, {
    path: defaultKeybindingsPath(options.homeDir),
    debounceMs: options.keybindingsDebounceMs ?? DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  })

  const stopWorktreeChangesCollector = startWorktreeChangesCollector(
    orch,
    bus,
    options.worktreeChangesTickMs ?? DEFAULT_WORKTREE_CHANGES_TICK_MS,
    hasSubscribers,
  )

  const stopTranscriptActivityCollector = startTranscriptActivityCollector(
    orch,
    bus,
    options.transcriptActivityTickMs ?? DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
    hasSubscribers,
  )

  const stopPrStatusPoller = startPrStatusPoller(
    orch,
    options.prStatusPollMs ?? DEFAULT_PR_STATUS_POLL_MS,
    hasSubscribers,
  )

  // Same teardown order server.ts's close() used before the extraction.
  return () => {
    if (updateTimer) clearInterval(updateTimer)
    stopAutoTitlePoller()
    stopPrStatusPoller()
    stopUiPrefsWatcher()
    stopKeybindingsWatcher()
    stopWorktreeChangesCollector()
    stopTranscriptActivityCollector()
  }
}
