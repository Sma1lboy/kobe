/** @jsxImportSource @opentui/react */
/**
 * The sidebar tree's body — one scrollbox of ONE-CELL rows with progressive
 * per-level indent (owner call 2026-08-01, round 3). The chrome around it
 * (brand header / nav rail / view tabs / section-header grammar for project
 * groups) stays the flat sidebar's own components; inside the tree, density
 * wins: worktree rows compress the two-line card to one line, tabs indent
 * one level further.
 *
 * No fold anywhere (owner round 5): every project and worktree always shows
 * everything under it, so there are no twisties and no collapse state.
 *
 * One scrollbox, not the flat sidebar's two: a tree's whole point is that a
 * project and its worktrees scroll together, and the cursor indexes one flat
 * id list so one viewport is what "scroll the cursor into view" needs.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { SCRATCH_SECTION_ID, type TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { sidebarEmptyStateKey } from "../../../tui/panes/sidebar/view-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { SectionHeader } from "./chrome"
import { RecentJumpRow, TabTreeRow, type TreeRowShared, WorktreeTreeRow } from "./tree-rows"

export function SidebarTreeBody(props: {
  readonly rows: readonly TreeRow[]
  /** Row id → index in the tree's navigable flat id list. */
  readonly flatIndexOf: ReadonlyMap<string, number>
  /** A query is open and non-empty — picks the "no matches" empty state over
   *  the plain "nothing here yet". */
  readonly searching: boolean
  readonly shared: TreeRowShared
  readonly onProjectContextMenu?: (projectId: string, x: number, y: number) => void
  /** Project being dragged in move mode — wears the move chip. */
  readonly movingProjectId?: string | null
  readonly setScrollRef: (renderable: ScrollBoxRenderable | null) => void
}) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <scrollbox
      ref={props.setScrollRef}
      flexGrow={1}
      minHeight={0}
      stickyScroll={false}
      // Scrollbar fully hidden (owner taste 2026-07-09): the cursor drives
      // scrolling, the thumb column is pure noise.
      verticalScrollbarOptions={{ visible: false }}
    >
      <box flexShrink={0} gap={0}>
        {props.rows.map((row, i) => {
          if (row.kind === "project") {
            // The Scratch header (issue #33) reuses the project-row shape but
            // is a fixed section, not a repo: translated label, no context
            // menu (nothing to file, nothing to move).
            const isScratch = row.id === SCRATCH_SECTION_ID
            return (
              <SectionHeader
                key={row.id}
                label={isScratch ? t("tasks.header.scratch") : row.label}
                suffix={props.movingProjectId === row.id ? t("tasks.moveChip") : undefined}
                topPad={i > 0}
                onContextMenu={
                  props.onProjectContextMenu && !isScratch
                    ? (x, y) => props.onProjectContextMenu?.(row.id, x, y)
                    : undefined
                }
              />
            )
          }
          if (row.kind === "recent") {
            return (
              <RecentJumpRow
                key={row.id}
                rowId={row.id}
                flatIndex={props.flatIndexOf.get(row.id) ?? -1}
                task={row.task}
                shared={props.shared}
              />
            )
          }
          if (row.kind === "worktree") {
            return (
              <WorktreeTreeRow
                key={row.id}
                rowId={row.id}
                flatIndex={props.flatIndexOf.get(row.id) ?? -1}
                task={row.task}
                shared={props.shared}
              />
            )
          }
          return (
            <TabTreeRow
              key={row.id}
              rowId={row.id}
              flatIndex={props.flatIndexOf.get(row.id) ?? -1}
              task={row.task}
              tab={row.tab}
              shared={props.shared}
            />
          )
        })}
        {props.rows.length === 0 ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>
              {t(sidebarEmptyStateKey({ searching: props.searching, projectFilter: false }))}
            </text>
          </box>
        ) : null}
      </box>
    </scrollbox>
  )
}
