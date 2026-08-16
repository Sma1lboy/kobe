/**
 * Persist one terminal-title observation without depending on the React UI.
 * The live-title hook and golden tests share this transition so session
 * identity and display-title recording cannot drift apart.
 */

import { engineSessionIdFromTitle } from "../../engine/registry"
import type { VendorId } from "../../types/vendor"
import { demoteExitedEngine } from "./terminal-tab-identity"
import { type TabsState, setTabLastTitle, setTabLiveVendor, setTabSessionId } from "./terminal-tabs-core"

/** One live-title observation → the persisted tab identity snapshot. */
export function recordLiveTabTitle(
  state: TabsState,
  tabId: string,
  title: string,
  live: VendorId | null,
  shellCommand: readonly string[],
): TabsState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return state
  const demoted = demoteExitedEngine(tab, tab.liveVendor, live, shellCommand)
  if (demoted !== tab)
    return { ...state, tabs: state.tabs.map((candidate) => (candidate.id === tabId ? demoted : candidate)) }

  let next = state
  const discoveredSessionId = live ? engineSessionIdFromTitle(live, title) : null
  if (tab.kind === "engine" && discoveredSessionId && tab.sessionId !== discoveredSessionId) {
    next = setTabSessionId(next, tabId, discoveredSessionId)
  }
  // A vendor fallback id is useful for history/resume, but it is not a name.
  if (!discoveredSessionId) next = setTabLastTitle(next, tabId, title)
  return setTabLiveVendor(next, tabId, live)
}
