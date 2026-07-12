/**
 * Daemon-side live auto-title poller (KOB — auto-name live).
 *
 * A freshly-created task keeps its placeholder title `(new task)` until a
 * transcript contains its first usable user prompt. This daemon poller
 * derives the title without requiring any UI to stay attached.
 *
 * The engine still writes the conversation to its OWN on-disk transcript
 * (the same JSONL the Ops activity badge in `monitor/activity.ts` watches).
 * This poller reads that store on an interval for every still-placeholder
 * task and renames as soon as the first user message lands — no detach
 * required. The rename flows through `orch.setTitle` → `store.update` →
 * the `task.snapshot` broadcast, so every attached Tasks pane updates live.
 *
 * Self-limiting: only placeholder tasks touch disk (`deriveTitleFromSession`
 * returns `""` and the task keeps its placeholder when no usable user
 * message exists yet); once a task is named it's skipped on every later
 * tick. Best-effort: a per-task failure is logged, never fatal, and never
 * blocks the other tasks in the same tick.
 *
 * The detach-time rename in `tui/direct.ts` stays as a
 * belt-and-suspenders path for the case where the daemon isn't running
 * (e.g. a `kobe` started without a live daemon).
 */

import type { DaemonOrchestrator, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** Default re-scan cadence; responsive without hammering disk. */
export const DEFAULT_AUTO_TITLE_POLL_MS = 4000

/**
 * Resolve a task's first-user-prompt title from its on-disk transcript.
 * Injectable so the pass logic (placeholder filter, re-check guard, error
 * isolation) can be tested without a real worktree + transcript on disk.
 */
export type TitleDeriver = (worktree: string, vendor: VendorId) => Promise<string>

/** A task that this pass renamed, plus the title it was given. */
export interface AutoTitled {
  readonly id: string
  readonly title: string
}

/**
 * Run one pass: rename every still-placeholder task that now has a
 * usable first-user-prompt title. Sequential (gentle on disk) and
 * best-effort per task. Returns the tasks it renamed (id + new title) —
 * the live poller uses that to also rename each task's origin ChatTab
 * tests assert on the list. Pure orchestrator work with no terminal IO.
 */
export async function runAutoTitlePass(
  orch: DaemonOrchestrator,
  derive: TitleDeriver,
  placeholderTitle = "(new task)",
  defaultVendor: VendorId = "claude",
): Promise<AutoTitled[]> {
  const renamed: AutoTitled[] = []
  for (const task of orch.listTasks()) {
    // Archived tasks are settled — never re-derive their title. Skipped
    // before any disk read; un-archiving re-includes them on the next tick
    // (the live store reflects `archived` immediately). Matches the sidebar's
    // canonical `t.archived` predicate (tui/panes/sidebar/groups.ts).
    if (task.archived || task.title !== placeholderTitle || !task.worktreePath) continue
    try {
      const title = await derive(task.worktreePath, task.vendor ?? defaultVendor)
      if (!title) continue
      // Re-check under the live store: the user may have manually renamed
      // (or the detach-time path may have named it) between the snapshot
      // above and this await. `setTitle` is also a no-op if unchanged.
      const current = orch.getTask(task.id)
      if (!current || current.title !== placeholderTitle) continue
      await orch.setTitle(task.id, title)
      renamed.push({ id: task.id, title })
    } catch (err) {
      logDaemonError("auto-title-poller", err)
    }
  }
  return renamed
}

/**
 * Start the poller. Returns a `stop()` that clears the interval. Pass
 * `intervalMs <= 0` to disable (returns a no-op stop) — tests that don't
 * want a live timer use this.
 *
 * `hasSubscribers` is the consumer gate (KOB — idle-daemon collector
 * pause): each tick is a no-op while it returns `false`, so a gui-less
 * daemon with zero subscribed panes stops transcript reads that publish
 * to nobody. The
 * interval keeps running; a pass runs again on the first tick after a pane
 * subscribes. Omit to scan unconditionally (tests).
 */
export function startAutoTitlePoller(
  orch: DaemonOrchestrator,
  runtime: Pick<DaemonRuntimeAdapter, "deriveTitleFromSession" | "placeholderTaskTitle" | "defaultTaskVendor">,
  intervalMs: number = DEFAULT_AUTO_TITLE_POLL_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = (): void => {
    // Consumer gate: no subscribed pane means no Tasks pane is rendering a
    // live rename, so skip the disk work entirely.
    if (hasSubscribers && !hasSubscribers()) return
    // Skip if a previous pass is still in flight so a slow disk read can't
    // pile up overlapping scans.
    if (running) return
    running = true
    void runAutoTitlePass(orch, runtime.deriveTitleFromSession, runtime.placeholderTaskTitle, runtime.defaultTaskVendor)
      .catch((err) => logDaemonError("auto-title-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
