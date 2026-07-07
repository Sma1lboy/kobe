/**
 * Per-tab turn-state polling for the workspace terminal tabs (split out of
 * `TerminalTabs.tsx`, which was over the 500-line cap). The SAME
 * `startTurnStatusPoll` loop the Ops pane runs, with PTY IO in place of
 * tmux capture-pane — the in-process snapshot IS the pane capture. Shared
 * mode when the host passes the daemon's transcript.activity slice,
 * local fixed-cadence fallback otherwise. Polls attach lazily (a tab's PTY
 * spawns after its Terminal mounts and measures), retried on a slow tick.
 *
 * Must be called from a Solid component body (owns effects + onCleanup).
 */

import type { TranscriptActivity } from "@/client/remote-orchestrator"
import { engineEntry } from "@/engine/registry"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import type { VendorId } from "@/types/vendor"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { startTurnStatusPoll } from "../ops/activity-monitor"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { type TabsState, tabPtyKey } from "./terminal-tabs-core"

/** Cadence of the lazy turn-poll attach retry (a tab's PTY spawns after mount). */
const TURN_POLL_ATTACH_MS = 2000

export function createTurnPolls(deps: {
  taskId: string
  worktree: string
  /** Task-level engine — the fallback for tabs without a pinned vendor. */
  vendor: () => VendorId
  state: () => TabsState
  sharedActivity?: () => TranscriptActivity | null
  /** A background tab's turn just landed ✓ — notification hook. */
  onBackgroundDone: (tabId: string) => void
}): { turnStates: () => ReadonlyMap<string, ChatTabTurnState> } {
  const [turnStates, setTurnStates] = createSignal<ReadonlyMap<string, ChatTabTurnState>>(new Map())
  const turnPolls = new Map<string, () => void>()
  const [pollTick, setPollTick] = createSignal(0)
  const pollAttachTimer = setInterval(() => setPollTick((n) => n + 1), TURN_POLL_ATTACH_MS)
  onCleanup(() => clearInterval(pollAttachTimer))
  createEffect(() => {
    pollTick()
    const reg = getDefaultPtyRegistry()
    const engineIds = new Set<string>()
    for (const tab of deps.state().tabs) {
      if (tab.kind !== "engine") continue
      engineIds.add(tab.id)
      if (turnPolls.has(tab.id)) continue
      const key = tabPtyKey(deps.taskId, tab.id)
      // Attach only once the PTY exists so the loop's prime() hashes a
      // real first capture (the Ops pane's prime-before-poll contract).
      if (!reg.has(key)) continue
      const tabId = tab.id
      const detector = engineEntry(tab.vendor ?? deps.vendor()).createTurnDetector()
      const dispose = startTurnStatusPoll(
        {
          worktree: deps.worktree,
          detector,
          // Shared mode (issue #24): the daemon's transcript.activity push
          // supplies completion reads + drives the adaptive capture
          // cadence; null (no daemon data) falls back to fixed-cadence
          // local polling — the Ops pane's exact contract.
          usingShared: () => (deps.sharedActivity?.() ?? null) !== null,
          sharedEntry: () => deps.sharedActivity?.() ?? null,
        },
        {
          sessionAttached: async () => true,
          capturePane: async () => {
            const pty = getDefaultPtyRegistry().get(key)
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
            if (turn === "done" && deps.state().activeId !== tabId) deps.onBackgroundDone(tabId)
          },
        },
      )
      turnPolls.set(tabId, dispose)
    }
    // Tabs that closed or degraded to a shell stop polling.
    for (const [id, dispose] of turnPolls) {
      if (engineIds.has(id)) continue
      dispose()
      turnPolls.delete(id)
      setTurnStates((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }
  })
  onCleanup(() => {
    for (const dispose of turnPolls.values()) dispose()
  })
  return { turnStates }
}
