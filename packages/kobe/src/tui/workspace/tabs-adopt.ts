/**
 * Adopt live-but-unregistered pty sessions into a task's tab state.
 *
 * The pty host holds the truth about what is running; the tab snapshot is a
 * record of intent, and the two diverge (issue #20 — a canonical-spawn
 * fallback, a tab closed while its task was unmounted so the kill never
 * reached the host, an older kobe). The sidebar already SHOWS such sessions
 * as `⚠` rows, but a row that isn't in the tab state can't be opened,
 * focused or closed: the owner sees a live engine he can neither read nor
 * end.
 *
 * So reconcile instead of only reporting: a live `<taskId>::<tabId>` session
 * the state doesn't list becomes a real engine tab under ITS OWN id, which
 * is what makes the ordinary open/close paths work on it (a mount attaches
 * to the existing host session under the same key — it does not respawn).
 * The adopted tab never steals `activeId`: adoption is bookkeeping, not a
 * navigation.
 */

import type { EngineTab, TabsState, TerminalTab } from "./terminal-tabs-core"

/** `tab-7` → 7, so an adopted tab keeps the ordinal its id already implies
 *  (the strip labels engine tabs by ordinal — minting a fresh one would
 *  rename a session the user knows as "Claude Code 7"). */
function ordinalOf(tabId: string, fallback: number): number {
  const match = /^tab-(\d+)$/.exec(tabId)
  return match ? Number(match[1]) : fallback
}

/**
 * Append `tabIds` as engine tabs, skipping ids the state already has.
 * Identity-stable when there is nothing to adopt, so callers can use the
 * result to decide whether to write at all.
 */
export function adoptTabs(state: TabsState, tabIds: readonly string[]): TabsState {
  const known = new Set(state.tabs.map((tab) => tab.id))
  const fresh: string[] = []
  for (const id of tabIds) {
    if (known.has(id)) continue
    known.add(id)
    fresh.push(id)
  }
  if (fresh.length === 0) return state

  let minted = state.nextOrdinal
  const adopted: EngineTab[] = fresh.map((id) => ({
    kind: "engine",
    id,
    title: null,
    ordinal: ordinalOf(id, minted++),
    // The session already exists — a spawn here would run a second engine
    // under the key we are adopting.
    spawned: true,
  }))
  adopted.sort((a, b) => a.ordinal - b.ordinal)

  const tabs: TerminalTab[] = [...state.tabs, ...adopted]
  const maxOrdinal = tabs.reduce((max, tab) => Math.max(max, tab.ordinal), 0)
  return { tabs, activeId: state.activeId, nextOrdinal: Math.max(state.nextOrdinal, maxOrdinal + 1) }
}
