/**
 * Files-column activity badge (issue #21) — React port of
 * `tui/workspace/files-badge.ts` (issue #16 React migration). Same
 * contract: the Ops pane's `● new` transcript badge, absorbed into the
 * files column — the baseline seeds at "now's newest" so mounting onto a
 * busy task doesn't flash stale activity, and FileTree's refresh (`r`) is
 * the "I've looked" ack (`ackRefresh`). Source is the daemon's
 * transcript.activity push, with the Ops pane's exact local-mtime fallback
 * (`startLocalBadgePoll`) when no daemon data is available.
 *
 * Solid→React deltas: `Accessor` deps become plain values (the host
 * re-renders on prop change); `createEffect(on(...))` becomes a
 * dependency-keyed `useEffect`; the poll's cleanup returns straight from
 * `useEffect` instead of `onCleanup`.
 */

import { useEffect, useRef, useState } from "react"
import type { TranscriptActivityMap } from "../../client/remote-orchestrator.ts"
import { latestTranscriptMtime } from "../../monitor/activity.ts"
import { startLocalBadgePoll } from "../../tui/ops/activity-monitor"
import type { VendorId } from "../../types/vendor.ts"
import { useT } from "../i18n"

export type FilesBadge = { text: string; active: boolean }

export function useFilesBadge(deps: {
  /** The active task's worktree (null when none). Badge resets on change. */
  worktree: string | null
  /** The active task's engine vendor — drives the local-mtime fallback probe. */
  vendor: VendorId
  /** Daemon transcript.activity push; null when the daemon has no data yet. */
  activityMap: TranscriptActivityMap | null
}): { cornerBadge: FilesBadge | null; ackRefresh: () => void } {
  const t = useT()
  const [badgeBaseline, setBadgeBaseline] = useState(0)
  const [badgeLatest, setBadgeLatest] = useState(0)
  const [badgePrimed, setBadgePrimed] = useState(false)
  // Untracked read for the poll's `isPrimed()` (Solid reads the live
  // signal even inside a closure created on an earlier run) — React
  // closures go stale across renders, so a ref mirrors the latest value.
  const badgePrimedRef = useRef(badgePrimed)
  badgePrimedRef.current = badgePrimed

  // Reset on worktree change — the Solid `on(deps.worktree, ...)` effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps.worktree is a TRIGGER (the effect body doesn't read it), matching the Solid `on(deps.worktree, ...)` guard.
  useEffect(() => {
    setBadgePrimed(false)
    setBadgeBaseline(0)
    setBadgeLatest(0)
  }, [deps.worktree])

  useEffect(() => {
    const wt = deps.worktree
    const map = deps.activityMap
    if (!wt || !map) return
    const mtime = map.get(wt)?.mtimeMs ?? 0
    setBadgePrimed((primed) => {
      if (!primed && mtime > 0) {
        setBadgeBaseline(mtime)
        return true
      }
      return primed
    })
    setBadgeLatest(mtime)
  }, [deps.worktree, deps.activityMap])

  useEffect(() => {
    const wt = deps.worktree
    if (!wt || deps.activityMap !== null) return
    const vendor = deps.vendor
    return startLocalBadgePoll(
      // In-process host: no tmux attach gate (the pane is visible iff the
      // app runs), only the engine-owned transcript mtime probe.
      { sessionAttached: async () => true, latestMtime: () => latestTranscriptMtime(vendor, wt) },
      {
        isPrimed: () => badgePrimedRef.current,
        prime: (mtime) => {
          setBadgePrimed(true)
          setBadgeBaseline(mtime)
        },
        setLatest: setBadgeLatest,
      },
    )
  }, [deps.worktree, deps.activityMap, deps.vendor])

  const cornerBadge: FilesBadge | null =
    badgePrimed && badgeLatest > badgeBaseline ? { text: t("ops.badge.newActivity"), active: true } : null
  const ackRefresh = (): void => setBadgeBaseline(badgeLatest)

  return { cornerBadge, ackRefresh }
}
