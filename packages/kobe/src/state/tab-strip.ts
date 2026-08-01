/**
 * Chat tab strip visibility preference (Settings → General → Terminal).
 *
 * The strip renders for every tab count by default — even a single tab, whose
 * row still carries the engine title and turn chip. Turn this on to get the
 * older behavior back: the strip hides while a ChatTab has only one tab.
 *
 * kv-persisted; read live by `tui-react/workspace/TerminalTabs.tsx`.
 */

export const TAB_STRIP_HIDE_SINGLE_KEY = "chat.tabStrip.hideSingle"

export const DEFAULT_TAB_STRIP_HIDE_SINGLE = false
