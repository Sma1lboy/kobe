/** @jsxImportSource @opentui/react */
/**
 * The sidebar tree's TAB rows (owner call 2026-08-01, round 2).
 *
 * Round 1 gave the tree its own one-line grammar for every row kind; the
 * owner's verdict was that the original design language must not change —
 * so project and worktree rows now render through the SAME `SectionHeader`
 * and `ProjectRowCard`/`TaskRowCard` the flat sidebar uses, and this file
 * keeps only the one row kind that is genuinely new: a worktree's tab.
 *
 * A tab row is one line indented under its card's subtitle column — it must
 * read as a child of the card, not as a third card style.
 */

import type { BoxRenderable } from "@opentui/core"
import type { TreeTab } from "../../../tui/panes/sidebar/tree-core"
import { useTheme } from "../../context/theme"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"

export type TreeTabRowShared = {
  /** Cursor position in the tree's flat id list. */
  readonly cursorIndex: number
  /** The row id the right pane is showing (`taskId::tabId` when a tab). */
  readonly activeRowId: string | null
  /** Keyed by FLAT INDEX — the same map the row cards register into, so one
   *  scroll-follow lookup covers cards and tab rows alike. */
  readonly rowEls: Map<number, BoxRenderable>
  readonly onPress: (flatIndex: number, rowId: string) => void
}

export function TabTreeRow(props: {
  readonly rowId: string
  readonly flatIndex: number
  readonly tab: TreeTab
  readonly shared: TreeTabRowShared
  /** True on the last tab of a task card's run — it carries the 1-cell
   *  spacer the card suppressed (`bottomPad={false}`) to keep its tabs
   *  visually attached. */
  readonly bottomPad?: boolean
}) {
  const { theme } = useTheme()
  const shared = props.shared
  const selection = resolveRowSelectionChrome(theme, {
    cursor: shared.cursorIndex === props.flatIndex,
    selected: shared.activeRowId === props.rowId,
  })
  const busy = props.tab.busy === true
  return (
    <box flexDirection="column" gap={0} paddingBottom={props.bottomPad ? 1 : 0}>
      <box
        ref={(renderable: BoxRenderable | null) => {
          if (!renderable) return
          shared.rowEls.set(props.flatIndex, renderable)
          return () => {
            if (shared.rowEls.get(props.flatIndex) === renderable) shared.rowEls.delete(props.flatIndex)
          }
        }}
        width="100%"
        flexDirection="row"
        gap={0}
        backgroundColor={selection.backgroundColor}
        onMouseUp={() => shared.onPress(props.flatIndex, props.rowId)}
      >
        <text fg={selection.markerColor} wrapMode="none">
          {selection.marker}
        </text>
        {/* paddingLeft 2 = the card subtitle's own indent, then the dot cell
            pushes the label one level further right than the subtitle. */}
        <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={0}>
          <text fg={busy ? theme.warning : theme.textMuted} wrapMode="none" width={2} flexShrink={0}>
            {busy ? "● " : "· "}
          </text>
          <text fg={theme.textMuted} wrapMode="none" flexGrow={1}>
            {props.tab.label}
          </text>
        </box>
      </box>
    </box>
  )
}
