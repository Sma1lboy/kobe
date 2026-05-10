/**
 * Sidebar primitive.
 *
 * Adapted from `refs/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`.
 * The opencode version reads from `useSync` (sessions, workspace info,
 * version metadata) and exposes plugin slots via `TuiPluginRuntime.Slot`. We
 * drop both: kobe doesn't have a plugin runtime in 0.2, and the sync store is
 * an empty stub. The sidebar here is a layout shell — fixed 42-char width,
 * scrollable body, footer — with a small `entries` API the future task list
 * (Wave 2 Stream F) will plug into.
 *
 * This is intentionally not the final task-grouped sidebar. It's the layout
 * frame so the lifted shell renders something sidebar-shaped on day 0.2.
 */

import { TextAttributes } from "@opentui/core"
import { For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"

export type SidebarEntry = {
  /** Stable id for selection state. */
  id: string
  /** Primary label. */
  label: string
  /** Optional secondary line (status, repo, etc.). */
  hint?: string
}

export type SidebarProps = {
  /** Title shown at the top of the sidebar. */
  title?: string
  /** Optional list of entries; pass `[]` (default) for an empty state. */
  entries?: SidebarEntry[]
  /** Currently selected entry id. */
  selected?: string
  /** Render this when `entries` is empty. */
  emptyMessage?: string
  /** Optional render slot for the footer (status, version, etc.). */
  footer?: JSX.Element
  /** When true, position absolute over content. Otherwise inline. */
  overlay?: boolean
  /** Selection callback. */
  onSelect?: (id: string) => void
}

export const SIDEBAR_WIDTH = 42

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()
  const entries = () => props.entries ?? []
  const empty = () => entries().length === 0

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={SIDEBAR_WIDTH}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <Show when={props.title}>
        <box paddingBottom={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
        </box>
      </Show>

      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <Show
          when={!empty()}
          fallback={
            <box paddingTop={1} paddingRight={1}>
              <text fg={theme.textMuted}>{props.emptyMessage ?? "No items."}</text>
            </box>
          }
        >
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={entries()}>
              {(entry) => {
                const active = () => entry.id === props.selected
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active() ? theme.primary : undefined}
                    onMouseUp={() => props.onSelect?.(entry.id)}
                  >
                    <text fg={active() ? theme.selectedListItemText : theme.text} wrapMode="none">
                      {entry.label}
                    </text>
                    <Show when={entry.hint}>
                      <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                        {entry.hint}
                      </text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </scrollbox>

      <Show when={props.footer}>
        <box flexShrink={0} paddingTop={1}>
          {props.footer}
        </box>
      </Show>
    </box>
  )
}
