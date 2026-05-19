/**
 * Agents-mode body for the chat pane (KOB-209).
 *
 * Renders a per-task overview of every ChatTab grouped by run-state —
 * `awaiting input → running → idle`. Click a card to switch back to
 * Chat mode focused on that tab.
 *
 * Data flows in through pure-projected `AgentRow`s; no orchestrator
 * dependency lives here. Composer stays mounted by the parent
 * (`ChatView`) — Agents-mode submit spawns a new tab in Chat.tsx.
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show } from "solid-js"
import type { Theme } from "../../context/theme"
import { type AgentRow, agentsGroupLabel, groupAgentRows } from "./agents-view-parts"

export interface AgentsViewProps {
  readonly theme: Theme
  readonly rows: Accessor<readonly AgentRow[]>
  readonly onSelectTab: (tabId: string) => void
}

export function AgentsView(props: AgentsViewProps) {
  const theme = props.theme
  const groups = () => groupAgentRows(props.rows())

  return (
    <scrollbox
      flexGrow={1}
      stickyScroll={false}
      verticalScrollbarOptions={{
        trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
      }}
    >
      <box flexDirection="column" gap={1} paddingTop={1} paddingRight={1}>
        <Show
          when={props.rows().length > 0}
          fallback={
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>No agents yet — submit a prompt to spawn one.</text>
            </box>
          }
        >
          <For each={groups()}>
            {(g) => (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1} paddingLeft={1}>
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
                    {agentsGroupLabel(g.group).toUpperCase()}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    ({g.rows.length})
                  </text>
                </box>
                <For each={g.rows}>{(row) => <AgentCard theme={theme} row={row} onSelect={props.onSelectTab} />}</For>
              </box>
            )}
          </For>
        </Show>
      </box>
    </scrollbox>
  )
}

function AgentCard(props: { theme: Theme; row: AgentRow; onSelect: (tabId: string) => void }) {
  const theme = props.theme
  const row = props.row
  const dotColor = () => {
    if (row.state === "awaiting_input") return theme.warning
    if (row.state === "running") return theme.success
    return theme.textMuted
  }
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={row.isActive ? theme.backgroundElement : undefined}
      onMouseUp={() => props.onSelect(row.tabId)}
    >
      <box flexDirection="row" gap={1}>
        <text fg={dotColor()} wrapMode="none">
          ●
        </text>
        <text fg={theme.text} attributes={row.isActive ? TextAttributes.BOLD : undefined} wrapMode="none">
          {row.label}
        </text>
        <Show when={row.isActive}>
          <text fg={theme.accent} wrapMode="none">
            (current)
          </text>
        </Show>
      </box>
      <Show when={row.preview.length > 0}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {row.preview}
          </text>
        </box>
      </Show>
    </box>
  )
}
