/** @jsxImportSource @opentui/react */
/**
 * The sidebar tree's body — one scrollbox rendering the flat sidebar's OWN
 * components over the tree's row list (owner call 2026-08-01, round 2: the
 * tree must keep the original design language, not invent a new grammar).
 *
 * - project row  → the same `SectionHeader` the PROJECTS/TASKS headers use,
 *                  labelled with the repo basename (+ a twisty prefix).
 * - worktree row → the same two-line `ProjectRowCard` / `TaskRowCard`.
 * - tab row      → `TabTreeRow`, the one genuinely new row kind.
 *
 * One scrollbox, not the flat sidebar's two: a tree's whole point is that a
 * project and its worktrees scroll together, and the cursor indexes one flat
 * id list so one viewport is what "scroll the cursor into view" needs.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import type { SidebarRow, SidebarView } from "../../../tui/panes/sidebar/groups"
import type { TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { sidebarEmptyStateKey } from "../../../tui/panes/sidebar/view-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { SectionHeader } from "./chrome"
import { ProjectRowCard, type SidebarRowCardSharedProps, TaskRowCard } from "./row-cards"
import { TabTreeRow, type TreeTabRowShared } from "./tree-rows"

export function SidebarTreeBody(props: {
  readonly rows: readonly TreeRow[]
  /** Row id → index in the tree's navigable flat id list. */
  readonly flatIndexOf: ReadonlyMap<string, number>
  readonly collapsedProjects: ReadonlySet<string>
  readonly view: SidebarView
  readonly cardShared: SidebarRowCardSharedProps
  readonly tabShared: TreeTabRowShared
  readonly onToggleProject: (projectId: string) => void
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
            const collapsed = props.collapsedProjects.has(row.id)
            return (
              <SectionHeader
                key={row.id}
                prefix={collapsed ? "▸" : "▾"}
                label={row.label}
                topPad={i > 0}
                onPress={() => props.onToggleProject(row.id)}
              />
            )
          }
          if (row.kind === "worktree") {
            const flatIndex = props.flatIndexOf.get(row.id) ?? -1
            const sidebarRow: SidebarRow = { kind: "task", task: row.task, flatIndex }
            const tabsFollow = props.rows[i + 1]?.kind === "tab"
            if (row.task.kind === "main") {
              // ProjectRowCard packs tight by design; when no tab rows attach
              // beneath it, restore the 1-row spacer every worktree unit ends
              // with (the last tab carries it otherwise).
              return (
                <box key={row.id} flexDirection="column" gap={0} paddingBottom={tabsFollow ? 0 : 1}>
                  <ProjectRowCard row={sidebarRow} shared={props.cardShared} />
                </box>
              )
            }
            return (
              <TaskRowCard
                key={row.id}
                row={sidebarRow}
                shared={props.cardShared}
                bottomPad={tabsFollow ? false : undefined}
              />
            )
          }
          const lastOfRun = props.rows[i + 1]?.kind !== "tab"
          return (
            <TabTreeRow
              key={row.id}
              rowId={row.id}
              flatIndex={props.flatIndexOf.get(row.id) ?? -1}
              tab={row.tab}
              shared={props.tabShared}
              bottomPad={lastOfRun}
            />
          )
        })}
        {props.rows.length === 0 ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>
              {t(sidebarEmptyStateKey({ searching: false, projectFilter: false, view: props.view }))}
            </text>
          </box>
        ) : null}
      </box>
    </scrollbox>
  )
}
