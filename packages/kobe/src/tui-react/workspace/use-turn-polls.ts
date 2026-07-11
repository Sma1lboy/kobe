/**
 * Per-tab turn-state polling for the workspace terminal tabs — React port
 * of `tui/workspace/turn-polls.ts` (issue #16 React migration). Same
 * `startTurnStatusPoll` loop the Ops pane runs, with PTY IO in place of
 * tmux capture-pane; shared mode when the host passes the daemon's
 * transcript.activity slice, local fixed-cadence fallback otherwise.
 *
 * Unified process-identity model (owner 2026-07-07): every tab is a shell;
 * an engine is just a process running in it. A tab gets a turn detector
 * attached whenever its foreground process IS an engine — kobe-launched
 * (an engine tab with a live engine leaf) OR user-typed (`claude` in a
 * plain shell, detected from the PTY's OSC window title via
 * `vendorFromTerminalTitle`), detaching again the moment the title stops
 * matching. `targetFor`/`soloKey` (identity resolution) are the shared
 * framework-free `turn-target.ts` — the Solid original and this hook use
 * the exact same rule. The same title stream feeds `liveTitles` — the tab
 * strip's dynamic "$process $ordinal" default names.
 *
 * Solid→React deltas: the reconcile pass is a `useEffect` keyed on
 * `[taskId, worktree, state, pollTick]` (Solid's fine-grained `createEffect`
 * re-ran on every read of `deps.state()`/`pollTick()`; `state` — the tabs
 * snapshot — becoming a plain dependency gives the same "re-run whenever
 * tabs change" behavior). Values only needed inside long-lived detector
 * closures (`sharedActivity`, `onBackgroundDone`, the latest `state` for
 * the active-tab check) ride refs refreshed every render — the closures
 * are created once per attach and must not go stale between renders,
 * mirroring `ops/host.tsx`'s `sharedMapRef` convention. The `turnPolls` Map
 * lives in a ref so it persists across renders without becoming React state
 * churn; the per-tab live-title tracking is the shared framework-free
 * `TitleSubscriptions` store (O18) — the same instance-compared reconcile
 * this hook used to hand-write, now shared with `TerminalSplit.tsx`.
 */

import { useEffect, useRef, useState } from "react"
import type { TranscriptActivity } from "../../client/remote-orchestrator"
import { engineEntry } from "../../engine/registry"
import type { ChatTabTurnState } from "../../engine/turn-detector"
import { startTurnStatusPoll } from "../../tui/ops/activity-monitor"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import type { TabsState } from "../../tui/workspace/terminal-tabs-core"
import { soloKey, targetFor } from "../../tui/workspace/turn-target"
import type { VendorId } from "../../types/vendor"
import { useLatest } from "../lib/use-latest"
import { type TitleSubscriptions, createTitleSubscriptions } from "./title-subscriptions"

/** Cadence of the lazy attach retry (a tab's PTY spawns after mount). */
const TURN_POLL_ATTACH_MS = 2000

export function useTurnPolls(deps: {
  taskId: string
  worktree: string
  /** Task-level engine — the fallback for tabs without a pinned vendor. */
  vendor: VendorId
  state: TabsState
  sharedActivity?: TranscriptActivity | null
  /** A background tab's turn just landed ✓ — notification hook. */
  onBackgroundDone: (tabId: string) => void
}): {
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  /** tabId → live foreground-process display name (engine binary when the
   *  title matches a vendor, else the raw OSC title). Feeds the tab
   *  strip's dynamic default names. */
  liveTitles: ReadonlyMap<string, string>
  /** tabId → resolved live engine identity — the `targetFor` vendor the
   *  attached detector tracks, whether kobe-launched or user-typed. The tab
   *  strip's launch-path-agnostic "does this process own its status" input. */
  turnVendors: ReadonlyMap<string, VendorId>
} {
  const [turnStates, setTurnStates] = useState<ReadonlyMap<string, ChatTabTurnState>>(new Map())
  const [liveTitles, setLiveTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const [turnVendors, setTurnVendors] = useState<ReadonlyMap<string, VendorId>>(new Map())
  const turnPollsRef = useRef(new Map<string, { dispose: () => void; vendor: VendorId; key: string }>())
  /** Shared live-title store: ptyKey → display title, instance-compared so a
   *  release + respawn at the same key drops the dead PTY's stale title
   *  before targets are computed (a dead claude's title must not keep a
   *  detector attached to the fresh shell). Same store `TerminalSplit` uses. */
  const titleStoreRef = useRef<TitleSubscriptions | null>(null)
  if (titleStoreRef.current === null) titleStoreRef.current = createTitleSubscriptions()
  const [pollTick, setPollTick] = useState(0)

  // A title push (not from this hook's own reconcile) may flip a tab's engine
  // identity — re-evaluate attach/detach the moment a user-typed engine
  // announces itself, not on the next slow tick.
  useEffect(() => titleStoreRef.current?.subscribe(() => setPollTick((n) => n + 1)), [])

  // Latest-render mirrors for the long-lived detector closures (created
  // once per attach, must never go stale between renders).
  const sharedActivityRef = useLatest(deps.sharedActivity)
  const onBackgroundDoneRef = useLatest(deps.onBackgroundDone)
  const stateRef = useLatest(deps.state)

  useEffect(() => {
    const timer = setInterval(() => setPollTick((n) => n + 1), TURN_POLL_ATTACH_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    void pollTick
    const reg = getDefaultPtyRegistry()
    const attached = new Set<string>()
    const turnPolls = turnPollsRef.current
    const titleStore = titleStoreRef.current
    if (!titleStore) return

    // Pass 1 — reconcile title subscriptions on every tab's solo PTY through
    // the shared store (instance-compared: a release + respawn at the same
    // key drops the dead PTY's stale title before targets are computed).
    const soloKeys = new Map<string, string>() // ptyKey → tabId
    for (const tab of deps.state.tabs) {
      const key = soloKey(deps.taskId, tab)
      if (key) soloKeys.set(key, tab.id)
    }
    titleStore.reconcile(soloKeys.keys())
    // Project the store's ptyKey→title map onto tabId→title for render; identity-
    // stable so the slow tick doesn't churn re-renders when nothing moved.
    setLiveTitles((prev) => {
      const next = new Map<string, string>()
      for (const [key, tabId] of soloKeys) {
        const title = titleStore.get(key)
        if (title !== undefined) next.set(tabId, title)
      }
      if (next.size === prev.size && [...next].every(([id, v]) => prev.get(id) === v)) return prev
      return next
    })

    // Pass 2 — attach/detach detectors per the tab's process identity.
    // `targetFor` reads the store by the tab's solo ptyKey (the same key it
    // resolves for the title lookup).
    for (const tab of deps.state.tabs) {
      const target = targetFor(deps.taskId, tab, deps.vendor, (key) => titleStore.get(key))
      if (!target) continue
      const existing = turnPolls.get(tab.id)
      if (existing && existing.vendor === target.vendor && existing.key === target.key) {
        attached.add(tab.id)
        continue
      }
      if (existing) {
        existing.dispose()
        turnPolls.delete(tab.id)
      }
      // Attach only once the PTY exists so the loop's prime() hashes a
      // real first capture (the Ops pane's prime-before-poll contract).
      if (!reg.has(target.key)) continue
      const tabId = tab.id
      const detector = engineEntry(target.vendor).createTurnDetector()
      const dispose = startTurnStatusPoll(
        {
          worktree: deps.worktree,
          detector,
          // Shared mode (issue #24): the daemon's transcript.activity push
          // supplies completion reads + drives the adaptive capture
          // cadence; null (no daemon data) falls back to fixed-cadence
          // local polling — the Ops pane's exact contract.
          usingShared: () => (sharedActivityRef.current ?? null) !== null,
          sharedEntry: () => sharedActivityRef.current ?? null,
        },
        {
          sessionAttached: async () => true,
          capturePane: async () => {
            const pty = getDefaultPtyRegistry().get(target.key)
            if (!pty) throw new Error("pty gone")
            return pty
              .capture()
              .map((row) => row.map((chunk) => chunk.text).join(""))
              .join("\n")
          },
          setTurnState: async (turn) => {
            setTurnStates((prev) => new Map(prev).set(tabId, turn))
            // Background completion rides the standard notification path
            // (unread + toast) — the PTY-world version of noticing a ✓
            // land on an unfocused tmux window.
            if (turn === "done" && stateRef.current.activeId !== tabId) onBackgroundDoneRef.current(tabId)
          },
        },
      )
      turnPolls.set(tabId, { dispose, vendor: target.vendor, key: target.key })
      attached.add(tabId)
    }

    // Tabs whose process is no longer an engine (closed, degraded, or the
    // user-typed engine exited back to the prompt) stop polling.
    for (const [id, poll] of turnPolls) {
      if (attached.has(id)) continue
      poll.dispose()
      turnPolls.delete(id)
      setTurnStates((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }

    // Mirror the attach map's resolved identities for render consumers.
    // Identity-stable: an unchanged map returns `prev` so the 2s attach
    // tick doesn't churn re-renders.
    setTurnVendors((prev) => {
      const next = new Map<string, VendorId>()
      for (const [id, poll] of turnPolls) next.set(id, poll.vendor)
      if (next.size === prev.size && [...next].every(([id, v]) => prev.get(id) === v)) return prev
      return next
    })
  }, [deps.taskId, deps.worktree, deps.vendor, deps.state, pollTick])

  // Final teardown on unmount only.
  useEffect(() => {
    return () => {
      for (const poll of turnPollsRef.current.values()) poll.dispose()
      titleStoreRef.current?.dispose()
    }
  }, [])

  return { turnStates, liveTitles, turnVendors }
}
