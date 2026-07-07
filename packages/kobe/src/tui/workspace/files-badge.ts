/**
 * Files-column activity badge (issue #21) — extracted from the workspace
 * host to keep `host.tsx` under the file-size cap.
 *
 * The Ops pane's `● new` transcript badge, absorbed into the files column:
 * the baseline seeds at "now's newest" so mounting onto a busy task doesn't
 * flash stale activity, and FileTree's refresh (`r`) is the "I've looked"
 * ack (`ackRefresh`). Source is the daemon's transcript.activity push, with
 * the Ops pane's exact local-mtime fallback (`startLocalBadgePoll`) when no
 * daemon data is available.
 */

import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"
import type { TranscriptActivityMap } from "../../client/remote-orchestrator.ts"
import { latestTranscriptMtime } from "../../monitor/activity.ts"
import type { VendorId } from "../../types/vendor.ts"
import { t } from "../i18n"
import { startLocalBadgePoll } from "../ops/activity-monitor"

export type FilesBadge = { text: string; active: boolean }

export function useFilesBadge(deps: {
  /** The active task's worktree (null when none). Badge resets on change. */
  worktree: Accessor<string | null>
  /** The active task's engine vendor — drives the local-mtime fallback probe. */
  vendor: Accessor<VendorId>
  /** Daemon transcript.activity push; null when the daemon has no data yet. */
  activityMap: Accessor<TranscriptActivityMap | null>
}): { cornerBadge: Accessor<FilesBadge | null>; ackRefresh: () => void } {
  const [badgeBaseline, setBadgeBaseline] = createSignal(0)
  const [badgeLatest, setBadgeLatest] = createSignal(0)
  const [badgePrimed, setBadgePrimed] = createSignal(false)

  createEffect(
    on(deps.worktree, () => {
      setBadgePrimed(false)
      setBadgeBaseline(0)
      setBadgeLatest(0)
    }),
  )
  createEffect(() => {
    const wt = deps.worktree()
    const map = deps.activityMap()
    if (!wt || !map) return
    const mtime = map.get(wt)?.mtimeMs ?? 0
    if (!badgePrimed() && mtime > 0) {
      setBadgePrimed(true)
      setBadgeBaseline(mtime)
    }
    setBadgeLatest(mtime)
  })
  createEffect(() => {
    const wt = deps.worktree()
    if (!wt || deps.activityMap() !== null) return
    const vendor = deps.vendor()
    onCleanup(
      startLocalBadgePoll(
        // In-process host: no tmux attach gate (the pane is visible iff the
        // app runs), only the engine-owned transcript mtime probe.
        { sessionAttached: async () => true, latestMtime: () => latestTranscriptMtime(vendor, wt) },
        {
          isPrimed: () => badgePrimed(),
          prime: (mtime) => {
            setBadgePrimed(true)
            setBadgeBaseline(mtime)
          },
          setLatest: setBadgeLatest,
        },
      ),
    )
  })

  const cornerBadge = (): FilesBadge | null =>
    badgePrimed() && badgeLatest() > badgeBaseline() ? { text: t("ops.badge.newActivity"), active: true } : null
  const ackRefresh = (): void => {
    setBadgeBaseline(badgeLatest())
  }

  return { cornerBadge, ackRefresh }
}
