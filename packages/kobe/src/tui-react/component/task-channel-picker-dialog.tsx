/** @jsxImportSource @opentui/react */
/** Task picker opened by `ctrl+a`, `@` from a focused engine chat. */

import { engineDisplayName } from "@/engine/interactive-command"
import type { Task } from "@/types/task"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"

const MAX_ROWS = 9

export function TaskChannelPickerView(props: {
  source: Task
  tasks: readonly Task[]
  onSubmit: (task: Task) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const [cursor, setCursor] = useState(0)
  const choices = props.tasks.filter(
    (task) => task.id !== props.source.id && !task.archived && task.worktreePath !== "",
  )
  const clamp = (next: number): number => Math.max(0, Math.min(choices.length - 1, next))
  const start = Math.max(0, Math.min(cursor - Math.floor(MAX_ROWS / 2), choices.length - MAX_ROWS))
  const visible = choices.slice(start, start + MAX_ROWS)

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
          const task = choices[cursor]
          if (task) commit(task)
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("channels.picker.title")}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <text fg={theme.textMuted}>{t("channels.picker.source", { task: props.source.title })}</text>
      {choices.length === 0 ? (
        <text fg={theme.textMuted}>{t("channels.picker.empty")}</text>
      ) : (
        <box flexDirection="column" gap={0}>
          {visible.map((task, index) => {
            const absolute = start + index
            const selected = absolute === cursor
            const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
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
                  {engineDisplayName(vendor)}
                </text>
              </box>
            )
          })}
        </box>
      )}
      <text fg={theme.textMuted}>{t("channels.picker.hint")}</text>
    </box>
  )
}

function show(dialog: DialogContext, source: Task, tasks: readonly Task[]): Promise<Task | undefined> {
  return showDialog<Task>(
    dialog,
    (resolve) => <TaskChannelPickerView source={source} tasks={tasks} onSubmit={(task) => resolve(task)} />,
    { size: "medium" },
  )
}

export const TaskChannelPickerDialog = { show }
