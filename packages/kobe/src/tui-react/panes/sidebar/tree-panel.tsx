/** @jsxImportSource @opentui/react */
/**
 * The sidebar's tree body — one scrollbox holding every project / worktree /
 * tab row (owner call 2026-08-01).
 *
 * One scrollbox, not the two the flat sidebar used: PROJECTS and TASKS were
 * separate sections because they were separate lists, but a tree's whole
 * point is that a project and its worktrees scroll together. The cursor
 * indexes one flat id list, so one viewport is also what "scroll the cursor
 * into view" needs.
 */

import { TextAttributes } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { ProjectTreeRow, TabTreeRow, type TreeGlyph, type TreeRowSharedProps, WorktreeTreeRow } from "./tree-rows"

export type { TreeGlyph }

export function SidebarTreeBody(props: {
  readonly rows: readonly TreeRow[]
  readonly expandedWorktrees: ReadonlySet<string>
  readonly collapsedProjects: ReadonlySet<string>
  readonly hasTabs: (taskId: string) => boolean
  readonly glyphFor: (row: Extract<TreeRow, { kind: "worktree" }>) => TreeGlyph
  readonly shared: TreeRowSharedProps
  readonly setScrollRef: (renderable: ScrollBoxRenderable | null) => void
  readonly emptyKey: string
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
        {props.rows.map((row) => {
          if (row.kind === "project") {
            return (
              <ProjectTreeRow
                key={row.id}
                row={row}
                collapsed={props.collapsedProjects.has(row.id)}
                shared={props.shared}
              />
            )
          }
          if (row.kind === "worktree") {
            const { glyph, color } = props.glyphFor(row)
            return (
              <WorktreeTreeRow
                key={row.id}
                row={row}
                expanded={props.expandedWorktrees.has(row.id)}
                hasTabs={props.hasTabs(row.task.id)}
                stateGlyph={glyph}
                stateColor={color}
                shared={props.shared}
              />
            )
          }
          return <TabTreeRow key={row.id} row={row} shared={props.shared} />
        })}
        {props.rows.length === 0 ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
              {t(props.emptyKey)}
            </text>
          </box>
        ) : null}
      </box>
    </scrollbox>
  )
}
