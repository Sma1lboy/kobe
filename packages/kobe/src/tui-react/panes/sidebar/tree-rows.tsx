/** @jsxImportSource @opentui/react */
/**
 * Tree row renderers — the project / worktree / tab rows of the sidebar
 * tree (owner call 2026-08-01, retiring the horizontal chattab strip).
 *
 * Separate from `row-cards.tsx` because these are a different grammar: a
 * task card is a two-line block with branch + change stats, while a tab row
 * is one line whose whole job is to be scannable at depth 2. Sharing the
 * card body would have meant threading "which of my four lines do I draw"
 * through every helper.
 *
 * Depth is drawn as leading indent, not as box nesting: the rows live in one
 * flat scrollbox (the cursor indexes a flat list — see `tree-core.ts`), so
 * nesting boxes per level would fight the flat scroll model for a purely
 * visual effect that two spaces already give.
 */

import { type BoxRenderable, type RGBA, TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import type { TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { useTheme } from "../../context/theme"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"

/** A worktree row's activity glyph, derived by the caller from the same
 *  `buildSidebarRowView` the flat sidebar's cards use. */
export interface TreeGlyph {
  readonly glyph: string
  /** `toneColor`'s output — an opentui colour, not a hex string. */
  readonly color: RGBA | string
}

/** Cells of indent per depth level. Two reads as a level without eating the
 *  rail's narrow width the way four would. */
const INDENT_CELLS = 2

export type TreeRowSharedProps = {
  /** The row id the cursor sits on (task id, or `taskId::tabId`). */
  readonly cursorId: string | null
  /** The active session's row id — what the right pane is showing. */
  readonly activeId: string | null
  readonly rowEls: Map<string, BoxRenderable>
  readonly onCursorTo: (rowId: string) => void
  readonly onActivate: (rowId: string) => void
  readonly onToggleExpand: (rowId: string) => void
}

function RowShell(props: {
  readonly rowId: string
  readonly depth: number
  readonly shared: TreeRowSharedProps
  readonly children: ReactNode
}) {
  const { theme } = useTheme()
  const shared = props.shared
  const selection = resolveRowSelectionChrome(theme, {
    cursor: shared.cursorId === props.rowId,
    selected: shared.activeId === props.rowId,
  })
  return (
    <box
      ref={(renderable: BoxRenderable | null) => {
        if (!renderable) return
        shared.rowEls.set(props.rowId, renderable)
        return () => {
          if (shared.rowEls.get(props.rowId) === renderable) shared.rowEls.delete(props.rowId)
        }
      }}
      width="100%"
      flexDirection="row"
      gap={0}
      backgroundColor={selection.backgroundColor}
      onMouseUp={() => {
        shared.onCursorTo(props.rowId)
        shared.onActivate(props.rowId)
      }}
    >
      <text fg={selection.markerColor} wrapMode="none">
        {selection.marker}
      </text>
      <text wrapMode="none" flexShrink={0}>
        {" ".repeat(props.depth * INDENT_CELLS)}
      </text>
      {props.children}
    </box>
  )
}

/** Disclosure glyph. A row with nothing to disclose still reserves the cell
 *  so titles at the same depth share one left edge. */
function Twisty(props: { readonly state: "open" | "closed" | "leaf" }) {
  const { theme } = useTheme()
  if (props.state === "leaf") {
    return (
      <text wrapMode="none" width={2} flexShrink={0}>
        {"  "}
      </text>
    )
  }
  return (
    <text fg={theme.textMuted} wrapMode="none" width={2} flexShrink={0}>
      {props.state === "open" ? "▾ " : "▸ "}
    </text>
  )
}

export function ProjectTreeRow(props: {
  readonly row: Extract<TreeRow, { kind: "project" }>
  readonly collapsed: boolean
  readonly shared: TreeRowSharedProps
}) {
  const { theme } = useTheme()
  return (
    <RowShell rowId={props.row.id} depth={props.row.depth} shared={props.shared}>
      <Twisty state={props.collapsed ? "closed" : "open"} />
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
        {props.row.label}
      </text>
    </RowShell>
  )
}

export function WorktreeTreeRow(props: {
  readonly row: Extract<TreeRow, { kind: "worktree" }>
  readonly expanded: boolean
  readonly hasTabs: boolean
  readonly stateGlyph: string
  readonly stateColor: TreeGlyph["color"]
  readonly shared: TreeRowSharedProps
}) {
  const { theme } = useTheme()
  const task = props.row.task
  // A main checkout shows the repo's branch; a task worktree shows its own.
  // Falling back to the title keeps a branchless row from rendering blank.
  const label = task.branch || task.title
  return (
    <RowShell rowId={props.row.id} depth={props.row.depth} shared={props.shared}>
      <Twisty state={props.hasTabs ? (props.expanded ? "open" : "closed") : "leaf"} />
      <text fg={props.stateColor} wrapMode="none" width={2} flexShrink={0}>
        {`${props.stateGlyph} `}
      </text>
      <text fg={theme.text} wrapMode="none" flexGrow={1}>
        {label}
      </text>
    </RowShell>
  )
}

export function TabTreeRow(props: {
  readonly row: Extract<TreeRow, { kind: "tab" }>
  readonly shared: TreeRowSharedProps
}) {
  const { theme } = useTheme()
  const busy = props.row.tab.busy === true
  return (
    <RowShell rowId={props.row.id} depth={props.row.depth} shared={props.shared}>
      {/* No twisty at the leaf level, but the cell stays so tab titles line
          up under their worktree's title rather than under its glyph. */}
      <Twisty state="leaf" />
      <text fg={busy ? theme.warning : theme.textMuted} wrapMode="none" width={2} flexShrink={0}>
        {busy ? "● " : "· "}
      </text>
      <text fg={theme.textMuted} wrapMode="none" flexGrow={1}>
        {props.row.tab.label}
      </text>
    </RowShell>
  )
}
