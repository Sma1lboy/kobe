/**
 * Chat tab strip visibility preference (Settings → General → Terminal).
 *
 * Three modes rather than a pair of booleans, because the states are
 * mutually exclusive and a `hidden + hideSingle` combination has no meaning:
 *
 *   - `always`      — the strip renders for every tab count, even a single
 *                     tab (whose row still carries the engine title and turn
 *                     chip). The pre-tree default.
 *   - `multipleOnly`— hide the strip while a task has only one tab.
 *   - `never`       — no strip at all: the sidebar tree lists every
 *                     worktree's tabs as rows, so the horizontal strip is a
 *                     second copy of the same list (owner call 2026-08-01).
 *
 * kv-persisted; read live by `tui-react/workspace/TerminalTabs.tsx`.
 */

export const TAB_STRIP_MODE_KEY = "chat.tabStrip.mode"

export type TabStripMode = "always" | "multipleOnly" | "never"

export const TAB_STRIP_MODES: readonly TabStripMode[] = ["always", "multipleOnly", "never"]

/**
 * The tree makes the strip redundant, so it is off by default (owner call
 * 2026-08-01). Users who want the strip back set it to `always`.
 */
export const DEFAULT_TAB_STRIP_MODE: TabStripMode = "never"

/** Legacy boolean key — `true` meant "hide while a task has one tab". */
export const TAB_STRIP_HIDE_SINGLE_KEY = "chat.tabStrip.hideSingle"

/**
 * Resolve the effective mode from stored values, honouring the legacy
 * boolean when the new key was never written.
 *
 * Migration reads rather than rewrites: a user who set the old toggle keeps
 * their strip behaviour, and the moment they touch the new setting the new
 * key wins for good. Rewriting on read would need a kv write from a render
 * path, and there is nothing to gain from it.
 */
export function resolveTabStripMode(stored: unknown, legacyHideSingle: unknown): TabStripMode {
  if (typeof stored === "string" && (TAB_STRIP_MODES as readonly string[]).includes(stored)) {
    return stored as TabStripMode
  }
  if (legacyHideSingle === true) return "multipleOnly"
  if (legacyHideSingle === false) return "always"
  return DEFAULT_TAB_STRIP_MODE
}

/** Whether the strip renders, given the mode and how many tabs exist. */
export function tabStripVisible(mode: TabStripMode, tabCount: number): boolean {
  if (mode === "never") return false
  if (mode === "multipleOnly") return tabCount >= 2
  return true
}
