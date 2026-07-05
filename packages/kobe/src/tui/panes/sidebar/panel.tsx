import { t } from "@/tui/i18n"
import { type BoxRenderable, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { Accessor } from "solid-js"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { SidebarProjectOption, SidebarRow, SidebarView as SidebarViewId, TaskSortMode } from "./groups"
import { SidebarHoverTooltip } from "./hover-tooltip"
import { ProjectRowCard, type SidebarRowCardSharedProps, TaskRowCard } from "./row-cards"
import type { SidebarHover, SidebarProps } from "./types"

export const VIEW_TABS: ReadonlyArray<{ view: SidebarViewId }> = [{ view: "active" }, { view: "archived" }]

export function viewTabLabel(view: SidebarViewId): string {
  switch (view) {
    case "active":
      return t("tasks.view.workspace")
    case "archived":
      return t("tasks.view.archives")
  }
}

function SectionHeader(props: { label: string; suffix?: string; topPad?: boolean }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.topPad}>
        <box flexShrink={0}>
          <text wrapMode="none"> </text>
        </box>
      </Show>
      <box flexDirection="row" flexShrink={0} gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {props.label}
        </text>
        <text fg={theme.border} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {"─".repeat(240)}
        </text>
        <Show when={props.suffix}>
          <text fg={theme.info} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
            {props.suffix}
          </text>
        </Show>
      </box>
    </box>
  )
}

export function SidebarPanel(props: {
  rootRef: (renderable: BoxRenderable) => void
  focused: Accessor<boolean>
  view: Accessor<SidebarViewId>
  setView: (view: SidebarViewId) => void
  sortMode: Accessor<TaskSortMode>
  hasSortToggle: boolean
  onSortModeToggle?: () => void
  searchMode: Accessor<boolean>
  searchQuery: Accessor<string>
  flatIds: Accessor<readonly string[]>
  totalRows: Accessor<number>
  projectRows: Accessor<readonly SidebarRow[]>
  taskRows: Accessor<readonly SidebarRow[]>
  hasTaskRows: Accessor<boolean>
  projectOptions: Accessor<readonly SidebarProjectOption[]>
  projectFilterRepo: Accessor<string | null>
  projectFilterLabel: Accessor<string>
  projectFilterCountLabel: Accessor<string>
  cycleProjectFilter: () => void
  projectScrollMaxHeight: Accessor<number>
  setProjectScrollRef: (renderable: ScrollBoxRenderable) => void
  setTaskScrollRef: (renderable: ScrollBoxRenderable) => void
  rowCardShared: SidebarRowCardSharedProps
  headerStatus?: SidebarProps["headerStatus"]
  onHeaderStatusClick?: () => void
  onAddTask?: () => void
  zenActive?: SidebarProps["zenActive"]
  onZenClick?: () => void
  hover: Accessor<SidebarHover | null>
  dims: Accessor<{ width: number; height: number }>
  renderHoverFallback: boolean
}) {
  const { theme } = useTheme()
  return (
    <box
      ref={props.rootRef}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
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
          <text
            fg={props.focused() ? theme.focusAccent : theme.textMuted}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            KOBE
          </text>
          <Show when={props.headerStatus?.()}>
            {(status) => (
              <text
                fg={status().emphasize ? theme.warning : theme.textMuted}
                attributes={status().emphasize ? TextAttributes.BOLD : TextAttributes.DIM}
                wrapMode="none"
                onMouseUp={() => props.onHeaderStatusClick?.()}
              >
                {status().label}
              </text>
            )}
          </Show>
        </box>
        <Show when={props.onAddTask}>
          <text
            fg={theme.primary}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={() => props.onAddTask?.()}
          >
            [+]
          </text>
        </Show>
      </box>

      <Show when={props.searchMode()}>
        <box flexDirection="row" gap={0} paddingBottom={1} paddingLeft={1}>
          <text fg={theme.info} wrapMode="none">
            /
          </text>
          <text fg={theme.text} wrapMode="none">
            {props.searchQuery()}
          </text>
          <text fg={theme.info} attributes={TextAttributes.BLINK} wrapMode="none">
            █
          </text>
          <Show when={props.searchQuery().length === 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {t("tasks.search.placeholder")}
            </text>
          </Show>
          <Show when={props.searchQuery().length > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {props.flatIds().length}/{props.totalRows()}
            </text>
          </Show>
        </box>
      </Show>

      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" gap={2}>
          <For each={VIEW_TABS}>
            {(tab) => {
              const active = () => props.view() === tab.view
              return (
                <text
                  fg={active() ? theme.primary : theme.textMuted}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => props.setView(tab.view)}
                >
                  {viewTabLabel(tab.view)}
                </text>
              )
            }}
          </For>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
            [/]
          </text>
        </box>
        <Show when={props.hasSortToggle}>
          <text
            fg={theme.textMuted}
            attributes={TextAttributes.DIM}
            wrapMode="none"
            onMouseUp={() => props.onSortModeToggle?.()}
          >
            {t("tasks.sort")}
          </text>
        </Show>
      </box>

      <Show when={props.projectRows().length > 0}>
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
            <Show when={props.projectOptions().length > 1}>
              <text
                fg={props.projectFilterRepo() ? theme.primary : theme.textMuted}
                attributes={props.projectFilterRepo() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                flexShrink={0}
              >
                {props.projectFilterLabel()}
              </text>
            </Show>
            <text fg={theme.border} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
              {"─".repeat(240)}
            </text>
            <Show when={props.projectOptions().length > 1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexShrink={0}>
                {props.projectFilterCountLabel()}
              </text>
            </Show>
          </box>
          <scrollbox
            ref={props.setProjectScrollRef}
            flexShrink={0}
            flexGrow={0}
            minHeight={0}
            maxHeight={props.projectScrollMaxHeight()}
            stickyScroll={false}
            verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
          >
            <box flexShrink={0} gap={0}>
              <For each={props.projectRows()}>{(row) => <ProjectRowCard row={row} shared={props.rowCardShared} />}</For>
            </box>
          </scrollbox>
        </box>
      </Show>

      <SectionHeader
        label={t("tasks.header.tasks")}
        suffix={props.sortMode() === "default" ? undefined : props.sortMode()}
        topPad={props.projectRows().length > 0}
      />
      <scrollbox
        ref={props.setTaskScrollRef}
        flexGrow={1}
        minHeight={0}
        stickyScroll={false}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <box flexShrink={0} gap={0}>
          <For each={props.taskRows()}>{(row) => <TaskRowCard row={row} shared={props.rowCardShared} />}</For>
          <Show when={props.flatIds().length === 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>
                {props.searchMode() && props.searchQuery().trim().length > 0
                  ? t("tasks.empty.noMatchSearch")
                  : props.projectFilterRepo()
                    ? props.view() === "active"
                      ? t("tasks.empty.noActiveProject")
                      : t("tasks.empty.noArchivedProject")
                    : props.view() === "active"
                      ? t("tasks.empty.noActive")
                      : t("tasks.empty.noArchived")}
              </text>
            </box>
          </Show>
          <Show
            when={
              props.projectFilterRepo() &&
              props.flatIds().length > 0 &&
              !props.hasTaskRows() &&
              !(props.searchMode() && props.searchQuery().trim().length > 0)
            }
          >
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {props.view() === "active" ? t("tasks.empty.noActiveProject") : t("tasks.empty.noArchivedProject")}
              </text>
            </box>
          </Show>
          <Show when={props.view() === "archived" && props.flatIds().length > 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {t("tasks.archiveHint")}
              </text>
            </box>
          </Show>
        </box>
      </scrollbox>

      <Show when={props.zenActive?.()}>
        <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text
            fg={theme.accent}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={() => props.onZenClick?.()}
          >
            ☯ ZEN
          </text>
        </box>
      </Show>

      <Show when={props.renderHoverFallback}>
        <SidebarHoverTooltip hover={props.hover} dims={props.dims} />
      </Show>
    </box>
  )
}
