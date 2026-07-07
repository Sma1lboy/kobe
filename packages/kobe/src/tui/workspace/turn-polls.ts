/**
 * Per-tab turn-state polling for the workspace terminal tabs (split out of
 * `TerminalTabs.tsx`, which was over the 500-line cap). The SAME
 * `startTurnStatusPoll` loop the Ops pane runs, with PTY IO in place of
 * tmux capture-pane — the in-process snapshot IS the pane capture. Shared
 * mode when the host passes the daemon's transcript.activity slice,
 * local fixed-cadence fallback otherwise. Polls attach lazily (a tab's PTY
 * spawns after its Terminal mounts and measures), retried on a slow tick.
 *
 * Unified process-identity model (owner 2026-07-07): every tab is a shell;
 * an engine is just a process running in it. A tab therefore gets a turn
 * detector attached whenever its foreground process IS an engine —
 * whether kobe launched it (an engine tab with a live engine leaf) or the
 * user typed `claude` into a plain shell. The latter is detected from the
 * PTY's OSC window title (`vendorFromTerminalTitle`), and detaches again
 * the moment the title stops matching (the engine exited back to the
 * shell prompt). The same title stream feeds `liveTitles` — the tab
 * strip's dynamic "$process $ordinal" default names.
 *
 * Must be called from a Solid component body (owns effects + onCleanup).
 */

import type { TranscriptActivity } from "@/client/remote-orchestrator"
import { engineEntry, titleDisplayName, vendorFromTerminalTitle } from "@/engine/registry"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import type { VendorId } from "@/types/vendor"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { startTurnStatusPoll } from "../ops/activity-monitor"
import type { TaskPtyLike } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { leaves } from "./split-core"
import { type TabsState, type TerminalTab, hasEngineLeaf, splitLeafPtyKey, tabPtyKey } from "./terminal-tabs-core"

/** Cadence of the lazy attach retry (a tab's PTY spawns after mount). */
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
}): {
  turnStates: () => ReadonlyMap<string, ChatTabTurnState>
  /** tabId → live foreground-process display name (engine binary when the
   *  title matches a vendor, else the raw OSC title). Feeds the tab
   *  strip's dynamic default names. */
  liveTitles: () => ReadonlyMap<string, string>
} {
  const [turnStates, setTurnStates] = createSignal<ReadonlyMap<string, ChatTabTurnState>>(new Map())
  const [liveTitles, setLiveTitles] = createSignal<ReadonlyMap<string, string>>(new Map())
  const turnPolls = new Map<string, { dispose: () => void; vendor: VendorId; key: string }>()
  /** ptyKey → raw OSC title. Cleared when the PTY instance at that key
   *  changes (release + respawn), so a dead claude's title can't keep a
   *  detector attached to the fresh shell that replaced it. */
  const titles = new Map<string, string>()
  const titleSubs = new Map<string, { pty: TaskPtyLike; unsub: () => void }>()
  const [pollTick, setPollTick] = createSignal(0)
  const pollAttachTimer = setInterval(() => setPollTick((n) => n + 1), TURN_POLL_ATTACH_MS)
  onCleanup(() => clearInterval(pollAttachTimer))

  /** The tab's single live PTY surface: unsplit tabs (and tabs collapsed
   *  to one leaf) have exactly one process to identify; a multi-leaf tab
   *  has no single "the tab's process", so title identity is undefined. */
  const soloKey = (tab: TerminalTab): string | null => {
    const tabKey = tabPtyKey(deps.taskId, tab.id)
    if (!tab.splitTree) return tabKey
    const ls = leaves(tab.splitTree.root)
    return ls.length === 1 ? splitLeafPtyKey(tabKey, ls[0].id) : null
  }

  /** What (if anything) to run a turn detector against for this tab:
   *  kobe-launched engine → pinned vendor at the tab key; anything else
   *  with a solo PTY whose live title matches an engine → that vendor. */
  const targetFor = (tab: TerminalTab): { vendor: VendorId; key: string } | null => {
    if (tab.kind === "engine" && hasEngineLeaf(tab.splitTree)) {
      return { vendor: tab.vendor ?? deps.vendor(), key: tabPtyKey(deps.taskId, tab.id) }
    }
    const key = soloKey(tab)
    if (!key) return null
    const vendor = vendorFromTerminalTitle(titles.get(key))
    return vendor ? { vendor, key } : null
  }

  createEffect(() => {
    pollTick()
    const reg = getDefaultPtyRegistry()
    const attached = new Set<string>()

    // Pass 1 — reconcile title subscriptions on every tab's solo PTY.
    // Instance-compared: release + respawn at the same key (shell degrade)
    // must drop the dead PTY's stale title before targets are computed.
    const soloKeys = new Map<string, string>() // ptyKey → tabId
    for (const tab of deps.state().tabs) {
      const key = soloKey(tab)
      if (key) soloKeys.set(key, tab.id)
    }
    for (const [key, sub] of titleSubs) {
      const cur = soloKeys.has(key) ? reg.get(key) : null
      if (cur === sub.pty) continue
      sub.unsub()
      titleSubs.delete(key)
      titles.delete(key)
    }
    for (const [key, tabId] of soloKeys) {
      if (titleSubs.has(key)) continue
      const pty = reg.get(key)
      if (!pty) continue
      const unsub = pty.onTitleChange((title) => {
        if (titles.get(key) === title) return
        titles.set(key, title)
        setLiveTitles((prev) => new Map(prev).set(tabId, titleDisplayName(title)))
        // Re-evaluate attach/detach now, not on the next slow tick — the
        // chip should land the moment a user-typed engine announces itself.
        setPollTick((n) => n + 1)
      })
      titleSubs.set(key, { pty, unsub })
    }
    setLiveTitles((prev) => {
      const alive = new Set(deps.state().tabs.map((t) => t.id))
      if (![...prev.keys()].some((id) => !alive.has(id))) return prev
      const next = new Map(prev)
      for (const id of next.keys()) if (!alive.has(id)) next.delete(id)
      return next
    })

    // Pass 2 — attach/detach detectors per the tab's process identity.
    for (const tab of deps.state().tabs) {
      const target = targetFor(tab)
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
          usingShared: () => (deps.sharedActivity?.() ?? null) !== null,
          sharedEntry: () => deps.sharedActivity?.() ?? null,
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
            if (turn === "done" && deps.state().activeId !== tabId) deps.onBackgroundDone(tabId)
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
  })
  onCleanup(() => {
    for (const poll of turnPolls.values()) poll.dispose()
    for (const sub of titleSubs.values()) sub.unsub()
  })
  return { turnStates, liveTitles }
}
