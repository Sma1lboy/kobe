/**
 * Sprint-8 — sidebar pane subprocess (Solid render).
 *
 * Flat task list. Lightweight on purpose — the rich Sidebar in
 * `src/tui/panes/sidebar/` is orchestrator-coupled (archive views,
 * search, branch polling) and not safe to mount over the daemon RPC
 * snapshot. A future "rich sidebar" sprint can hoist that work into
 * the daemon and re-mount here.
 *
 * Markers (left of title):
 *   ★  main task
 *   ●  in_progress / in_review
 *   ✓  done
 *   ✗  error / canceled
 *   ○  backlog (default)
 *
 * Active task row is highlighted with `theme.primary` background.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { PaneSignals } from "./shared"

const STATUS_MARKER: Record<string, string> = {
  in_progress: "●",
  in_review: "●",
  done: "✓",
  canceled: "✗",
  error: "✗",
  backlog: "○",
}

function markerFor(task: { kind: string; status: string }): string {
  if (task.kind === "main") return "★"
  return STATUS_MARKER[task.status] ?? "○"
}

export function SidebarPane(props: { signals: PaneSignals }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingTop={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
        TASKS
      </text>
      <box flexDirection="column" flexGrow={1} paddingTop={1} gap={0}>
        <Show
          when={props.signals.tasks().length > 0}
          fallback={
            <box flexDirection="column" gap={1}>
              <text fg={theme.textMuted} wrapMode="word">
                no tasks yet
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                press M-N (Shift+Alt+n) to create your first task
              </text>
            </box>
          }
        >
          <For each={props.signals.tasks() as readonly { id: string; title: string; kind: string; status: string }[]}>
            {(task) => {
              const isActive = () => props.signals.activeTaskId() === task.id
              const marker = markerFor(task)
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  gap={1}
                  backgroundColor={isActive() ? theme.primary : undefined}
                  flexShrink={0}
                  onMouseDown={() => {
                    if (isActive()) return
                    props.signals.dispatchRpc("rpc.switchTask", { id: task.id })
                  }}
                >
                  <text fg={isActive() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {marker}
                  </text>
                  <text
                    fg={isActive() ? theme.selectedListItemText : theme.text}
                    attributes={isActive() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {task.title}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </box>
  )
}
