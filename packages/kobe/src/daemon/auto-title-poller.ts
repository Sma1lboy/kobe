/**
 * Daemon-side live auto-title poller (KOB — auto-name live).
 *
 * In the v0.6 tmux model a freshly-created task keeps its placeholder
 * title `(new task)` until the user DETACHES and the outer monitor's
 * return path (`tui/app.tsx` / `tui/direct.ts`) reads the transcript and
 * renames. While attached, kobe's renderer is suspended and never sees
 * the interactive prompt — so the title used to stay `(new task)` for the
 * whole session.
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
 * The detach-time rename in `tui/app.tsx` / `tui/direct.ts` stays as a
 * belt-and-suspenders path for the case where the daemon isn't running
 * (e.g. a `kobe` started without a live daemon).
 */

import { deriveTitleFromSession } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import { PLACEHOLDER_TASK_TITLE } from "@/orchestrator/core"
import { renameOriginChatTab } from "@/tmux/chat-tab-naming"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"
import { logDaemonError } from "./crash-log"

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
 * window; tests assert on the list. Pure orchestrator work, no tmux.
 */
export async function runAutoTitlePass(
  orch: Orchestrator,
  derive: TitleDeriver = deriveTitleFromSession,
): Promise<AutoTitled[]> {
  const renamed: AutoTitled[] = []
  for (const task of orch.listTasks()) {
    if (task.title !== PLACEHOLDER_TASK_TITLE || !task.worktreePath) continue
    try {
      const title = await derive(task.worktreePath, task.vendor ?? DEFAULT_TASK_VENDOR)
      if (!title) continue
      // Re-check under the live store: the user may have manually renamed
      // (or the detach-time path may have named it) between the snapshot
      // above and this await. `setTitle` is also a no-op if unchanged.
      const current = orch.getTask(task.id)
      if (!current || current.title !== PLACEHOLDER_TASK_TITLE) continue
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
 */
export function startAutoTitlePoller(orch: Orchestrator, intervalMs: number = DEFAULT_AUTO_TITLE_POLL_MS): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = (): void => {
    // Skip if a previous pass is still in flight so a slow disk read can't
    // pile up overlapping scans.
    if (running) return
    running = true
    void runAutoTitlePass(orch)
      .then(async (renamed) => {
        // Mirror the new title onto each task's origin ChatTab window so the
        // tab strip stops reading `claude`/`zsh`. Best-effort and only the
        // first tab; skipped silently when the session/window is gone.
        for (const { id, title } of renamed) {
          await renameOriginChatTab(id, title).catch((err) => logDaemonError("auto-title-poller", err))
        }
      })
      .catch((err) => logDaemonError("auto-title-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
