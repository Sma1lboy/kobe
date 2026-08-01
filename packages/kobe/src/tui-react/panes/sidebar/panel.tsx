/** @jsxImportSource @opentui/react */
/**
 * React sidebar panel (issue #15, G3) — the presentational half of the
 * sidebar. All copy comes through `useT()` (language-reactive); tab
 * metadata and empty-state key selection are the shared framework-free
 * `src/tui/panes/sidebar/view-core.ts`.
 */

import { type BoxRenderable, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { SidebarProjectOption, SidebarRow, SidebarView, TaskSortMode } from "../../../tui/panes/sidebar/groups"
import type { SidebarNav } from "../../../tui/panes/sidebar/nav-core"
import { sidebarEmptyStateKey } from "../../../tui/panes/sidebar/view-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { SectionHeader, SidebarBrandHeader, SidebarNavRail, SidebarViewTabs, SidebarZenChip } from "./chrome"
import { SidebarHoverTooltip } from "./hover-tooltip"
import { ProjectRowCard, type SidebarRowCardSharedProps, TaskRowCard } from "./row-cards"
import type { SidebarHover, SidebarProps } from "./types"

export function SidebarPanel(props: {
  rootRef: (renderable: BoxRenderable | null) => void
  focused: boolean
  view: SidebarView
  setView: (view: SidebarView) => void
  nav: SidebarNav
  setNav: (nav: SidebarNav) => void
  sortMode: TaskSortMode
  searchMode: boolean
  searchQuery: string
  flatIds: readonly string[]
  totalRows: number
  projectRows: readonly SidebarRow[]
  taskRows: readonly SidebarRow[]
  hasTaskRows: boolean
  projectOptions: readonly SidebarProjectOption[]
  projectFilterRepo: string | null
  projectFilterLabel: string
  cycleProjectFilter: () => void
  projectScrollMaxHeight: number
  setProjectScrollRef: (renderable: ScrollBoxRenderable | null) => void
  setTaskScrollRef: (renderable: ScrollBoxRenderable | null) => void
  rowCardShared: SidebarRowCardSharedProps
  headerStatus?: SidebarProps["headerStatus"]
  onHeaderStatusClick?: () => void
  onAddTask?: () => void
  zenActive?: boolean
  onZenClick?: () => void
  hover: SidebarHover | null
  dims: { width: number; height: number }
  renderHoverFallback: boolean
}) {
  const { theme, transparentBackground } = useTheme()
  const dividerColor = transparentBackground ? theme.border : theme.borderSubtle
  const t = useT()
  const status = props.headerStatus ?? null
  return (
    <box
      ref={props.rootRef}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      // 1, not 0: the neighbouring panes' top FRAME border eats their row 0,
      // so the borderless rail needs one padding row to align with them.
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={0}
      paddingRight={0}
    >
      {/* Fixed header rows are flexShrink={0}: opentui boxes default to
          flexShrink=1, so on overflow Yoga collapses whichever padding row
          it rounds against — the layout jitter fixed 2026-07-17. Only the
          task scrollbox absorbs overflow. */}
      <SidebarBrandHeader
        focused={props.focused}
        status={status}
        onStatusClick={props.onHeaderStatusClick}
        onAddTask={props.onAddTask}
      />

      {props.searchMode ? (
        <box flexDirection="row" gap={0} flexShrink={0} paddingBottom={1} paddingLeft={1}>
          <text fg={theme.info} wrapMode="none">
            /
          </text>
          <text fg={theme.text} wrapMode="none">
            {props.searchQuery}
          </text>
          <text fg={theme.info} attributes={TextAttributes.BLINK} wrapMode="none">
            █
          </text>
          {props.searchQuery.length === 0 ? (
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {t("tasks.search.placeholder")}
            </text>
          ) : (
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {props.flatIds.length}/{props.totalRows}
            </text>
          )}
        </box>
      ) : null}

      <SidebarNavRail nav={props.nav} setNav={props.setNav} />

      {/* Archives filters the task list INSIDE the sidebar — it changes which
          tasks the list shows, and is unrelated to what the content pane on
          the right is displaying. */}
      <SidebarViewTabs view={props.view} setView={props.setView} />
      {/* Filter active ⇒ keep the header (and its filter label) visible even
          when the filtered repo has no main row to show. */}
      {props.projectRows.length > 0 || props.projectFilterRepo !== null ? (
        <box flexDirection="column" flexShrink={0}>
          <box
            flexDirection="row"
            flexShrink={0}
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => props.cycleProjectFilter()}
          >
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
              {t("tasks.header.projects")}
            </text>
            <text fg={dividerColor} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
              {"─".repeat(240)}
            </text>
            {/* Project-filter label sits at flex end (owner taste 2026-07-10);
                the task-count label is gone — not worth the cells. */}
            {props.projectOptions.length > 1 ? (
              <text
                fg={props.projectFilterRepo ? theme.text : theme.textMuted}
                attributes={props.projectFilterRepo ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                flexShrink={1}
              >
                {props.projectFilterLabel}
              </text>
            ) : null}
          </box>
          <scrollbox
            ref={props.setProjectScrollRef}
            flexShrink={0}
            flexGrow={0}
            minHeight={0}
            maxHeight={props.projectScrollMaxHeight}
            stickyScroll={false}
            // Scrollbar fully hidden (owner taste 2026-07-09): the cursor
            // drives scrolling, the thumb column is pure noise. `visible`
            // flips the ScrollBar's manual-visibility latch, so overflow
            // recalculation can't bring it back.
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexShrink={0} gap={0}>
              {props.projectRows.map((row) => (
                <ProjectRowCard key={row.task.id} row={row} shared={props.rowCardShared} />
              ))}
            </box>
          </scrollbox>
        </box>
      ) : null}

      <SectionHeader
        label={t("tasks.header.tasks")}
        suffix={props.sortMode === "default" ? undefined : props.sortMode}
        topPad={props.projectRows.length > 0 || props.projectFilterRepo !== null}
      />
      <scrollbox
        ref={props.setTaskScrollRef}
        flexGrow={1}
        minHeight={0}
        stickyScroll={false}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box flexShrink={0} gap={0}>
          {props.taskRows.map((row) => (
            <TaskRowCard key={row.task.id} row={row} shared={props.rowCardShared} />
          ))}
          {props.flatIds.length === 0 ? (
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>
                {t(
                  sidebarEmptyStateKey({
                    searching: props.searchMode && props.searchQuery.trim().length > 0,
                    projectFilter: props.projectFilterRepo !== null,
                    view: props.view,
                  }),
                )}
              </text>
            </box>
          ) : null}
          {props.projectFilterRepo &&
          props.flatIds.length > 0 &&
          !props.hasTaskRows &&
          !(props.searchMode && props.searchQuery.trim().length > 0) ? (
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {t(sidebarEmptyStateKey({ searching: false, projectFilter: true, view: props.view }))}
              </text>
            </box>
          ) : null}
          {props.view === "archived" && props.flatIds.length > 0 ? (
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {t("tasks.archiveHint")}
              </text>
            </box>
          ) : null}
        </box>
      </scrollbox>

      {props.zenActive ? <SidebarZenChip onZenClick={props.onZenClick} /> : null}

      {props.renderHoverFallback ? <SidebarHoverTooltip hover={props.hover} dims={props.dims} /> : null}
    </box>
  )
}
