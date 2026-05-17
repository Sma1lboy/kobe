/**
 * Background-runs bar — a one-line readout shown directly above the
 * chat composer, listing the agent sessions running out of view.
 *
 * Adapted from claude-code's `BackgroundTaskStatus`
 * (`refs/claude-code/src/components/tasks/`), which claude-code mounts
 * in its prompt-input footer so the user sees which agents are working
 * in the background while they compose the next message. kobe's case
 * differs: kobe is multi-task, so "an agent running in the background"
 * is a chat-tab session in another task (or another tab) — not a
 * sub-agent. The bar therefore renders one pill per background ChatTab
 * session, sourced from the same {@link computeBackgroundRows}
 * projection the status-bar indicator and the `ctrl+b` dialog use.
 *
 * Self-hides when nothing runs out of view. Clicking the bar opens the
 * full background-tasks dialog (same surface as double-pressing
 * `ctrl+b`).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createMemo } from "solid-js"
import type { BackgroundTaskRow } from "../../component/background-tasks-parts"
import { useTheme } from "../../context/theme"

/** How many pills to render inline before collapsing the rest into `+N`. */
const MAX_PILLS = 3

/** Truncate a task title so one pill can't dominate the row. */
function pillTitle(title: string): string {
  const t = title.trim() || "(untitled)"
  return t.length > 24 ? `${t.slice(0, 23)}…` : t
}

export interface BackgroundRunsBarProps {
  /** Background sessions (running / awaiting_input, minus the visible tab). */
  runs: Accessor<readonly BackgroundTaskRow[]>
  /** Open the background-tasks dialog — bar is mouse-clickable. */
  onOpen: () => void
}

export function BackgroundRunsBar(props: BackgroundRunsBarProps) {
  const { theme } = useTheme()
  const shown = createMemo(() => props.runs().slice(0, MAX_PILLS))
  const overflow = createMemo(() => Math.max(0, props.runs().length - MAX_PILLS))
  const anyAwaiting = createMemo(() => props.runs().some((r) => r.state === "awaiting_input"))

  return (
    <Show when={props.runs().length > 0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1} onMouseUp={() => props.onOpen()}>
        <text fg={anyAwaiting() ? theme.warning : theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
          ⦿
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {props.runs().length} running in background
        </text>
        <For each={shown()}>
          {(row) => {
            const awaiting = row.state === "awaiting_input"
            return (
              <box flexDirection="row" gap={1} flexShrink={1}>
                <text fg={theme.textMuted} wrapMode="none">
                  ·
                </text>
                <text fg={awaiting ? theme.warning : theme.text} wrapMode="none">
                  {awaiting ? `${pillTitle(row.taskTitle)} (needs input)` : pillTitle(row.taskTitle)}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={overflow() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            +{overflow()} more
          </text>
        </Show>
        <text fg={theme.accent} wrapMode="none">
          ctrl+b ctrl+b
        </text>
      </box>
    </Show>
  )
}
