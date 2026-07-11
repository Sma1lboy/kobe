/** @jsxImportSource @opentui/react */
/**
 * React sidebar panel (issue #15, G3) — the presentational half of the
 * sidebar. All copy comes through `useT()` (language-reactive); tab
 * metadata and empty-state key selection are the shared framework-free
 * `src/tui/panes/sidebar/view-core.ts`.
 */

import { type BoxRenderable, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { SidebarProjectOption, SidebarRow, SidebarView, TaskSortMode } from "../../../tui/panes/sidebar/groups"
import { VIEW_TABS, sidebarEmptyStateKey, viewTabLabelKey } from "../../../tui/panes/sidebar/view-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { SidebarHoverTooltip } from "./hover-tooltip"
import { ProjectRowCard, type SidebarRowCardSharedProps, TaskRowCard } from "./row-cards"
import type { SidebarHover, SidebarProps } from "./types"

function SectionHeader(props: { label: string; suffix?: string; topPad?: boolean }) {
  const { theme, transparentBackground } = useTheme()
  const dividerColor = transparentBackground ? theme.border : theme.borderSubtle
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.topPad ? (
        <box flexShrink={0}>
          <text wrapMode="none"> </text>
        </box>
      ) : null}
      <box flexDirection="row" flexShrink={0} gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {props.label}
        </text>
        <text fg={dividerColor} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {"─".repeat(240)}
        </text>
        {props.suffix ? (
          <text fg={theme.info} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
            {props.suffix}
          </text>
        ) : null}
      </box>
    </box>
  )
}

export function SidebarPanel(props: {
  rootRef: (renderable: BoxRenderable | null) => void
  focused: boolean
  view: SidebarView
  setView: (view: SidebarView) => void
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
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={0}
      paddingRight={0}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" gap={1}>
          {/* The outer pane border owns keyboard focus. Keep the brand neutral
              so it cannot compete with that one global focus signal. */}
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
            KOBE
          </text>
          {status ? (
            <text
              fg={status.emphasize ? theme.warning : theme.textMuted}
              attributes={status.emphasize ? TextAttributes.BOLD : TextAttributes.DIM}
              wrapMode="none"
              onMouseUp={() => props.onHeaderStatusClick?.()}
            >
              {status.label}
            </text>
          ) : null}
        </box>
        {props.onAddTask ? (
          <text
            fg={theme.primary}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={() => props.onAddTask?.()}
          >
            [+]
          </text>
        ) : null}
      </box>

      {props.searchMode ? (
        <box flexDirection="row" gap={0} paddingBottom={1} paddingLeft={1}>
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

      <box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1} paddingRight={1}>
        {VIEW_TABS.map((tab) => {
          const active = props.view === tab.view
          return (
            <text
              key={tab.view}
              fg={active ? theme.text : theme.textMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
              onMouseUp={() => props.setView(tab.view)}
            >
              {t(viewTabLabelKey(tab.view))}
            </text>
          )
        })}
      </box>

      {props.projectRows.length > 0 ? (
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
                flexShrink={0}
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
        topPad={props.projectRows.length > 0}
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

      {props.zenActive ? (
        <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text
            fg={theme.accent}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={(e: { stopPropagation(): void }) => {
              // Don't bubble to the pane box's focus-grab (workspace host):
              // zen entry moves focus to the terminal; a bubbled sidebar
              // focus would instantly exit zen via the focus guard.
              e.stopPropagation()
              props.onZenClick?.()
            }}
          >
            ☯ ZEN
          </text>
        </box>
      ) : null}

      {props.renderHoverFallback ? <SidebarHoverTooltip hover={props.hover} dims={props.dims} /> : null}
    </box>
  )
}
