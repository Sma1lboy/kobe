/** @jsxImportSource @opentui/react */
/** Jump portal for a primary Task with more than one linked subagent. */

import { engineDisplayName } from "@/engine/interactive-command"
import { linkedSubagents } from "@/tui/panes/sidebar/task-delegation-marks"
import { DEFAULT_TASK_VENDOR, type Task } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"

const MAX_ROWS = 9

function TaskSubagentsView(props: {
  readonly primary: Task
  readonly subagents: readonly Task[]
  readonly onSubmit: (task: Task) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const [cursor, setCursor] = useState(0)
  const clamp = (next: number): number => Math.max(0, Math.min(props.subagents.length - 1, next))
  const start = Math.max(0, Math.min(cursor - Math.floor(MAX_ROWS / 2), props.subagents.length - MAX_ROWS))
  const visible = props.subagents.slice(start, start + MAX_ROWS)

  const commit = (task: Task): void => {
    props.onSubmit(task)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => setCursor((value) => clamp(value + 1)) },
      { key: "down", cmd: () => setCursor((value) => clamp(value + 1)) },
      { key: "k", cmd: () => setCursor((value) => clamp(value - 1)) },
      { key: "up", cmd: () => setCursor((value) => clamp(value - 1)) },
      {
        key: "return",
        cmd: () => {
          const task = props.subagents[cursor]
          if (task) commit(task)
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("delegation.linked.title")}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <text fg={theme.textMuted}>{t("delegation.linked.primary", { task: props.primary.title })}</text>
      <box flexDirection="column" gap={0}>
        {visible.map((task, index) => {
          const selected = start + index === cursor
          return (
            <box
              key={task.id}
              flexDirection="row"
              gap={1}
              backgroundColor={selected ? theme.backgroundElement : undefined}
              paddingLeft={1}
              paddingRight={1}
              onMouseUp={() => commit(task)}
            >
              <text
                fg={selected ? theme.primary : theme.text}
                attributes={selected ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                flexGrow={1}
              >
                {selected ? "▸ " : "  "}
                {task.title}
              </text>
              <text fg={selected ? theme.accent : theme.textMuted} wrapMode="none" flexShrink={0}>
                {engineDisplayName(task.vendor ?? DEFAULT_TASK_VENDOR)}
              </text>
            </box>
          )
        })}
      </box>
      <text fg={theme.textMuted}>{t("delegation.linked.hint")}</text>
    </box>
  )
}

function show(dialog: DialogContext, primary: Task, tasks: readonly Task[]): Promise<Task | undefined> {
  const subagents = linkedSubagents(tasks, String(primary.id))
  return showDialog<Task>(
    dialog,
    (resolve) => <TaskSubagentsView primary={primary} subagents={subagents} onSubmit={(task) => resolve(task)} />,
    { size: "medium" },
  )
}

export const TaskSubagentsDialog = { show }
