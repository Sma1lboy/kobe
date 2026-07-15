/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import type { AttentionInboxItem, RemoteOrchestrator } from "../../client/remote-orchestrator"
import { tabTitle } from "../../tui/workspace/terminal-tabs-core"
import type { Task } from "../../types/task"
import { DEFAULT_TASK_VENDOR } from "../../types/task"
import { bindByIds } from "../context/keybindings"
import { type KVContext, useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useAccessor } from "../lib/use-accessor"
import { type DialogContext, useDialog } from "../ui/dialog"
import { attentionInboxKey, isAttentionInboxItemAvailable, sortAttentionInbox } from "./attention-inbox-core"
import { knownTaskTab } from "./terminal-tabs-shared"

const MAX_DIALOG_ROWS = 10

function itemColor(state: AttentionInboxItem["state"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (state === "permission_needed") return theme.warning
  if (state === "turn_complete") return theme.success
  return theme.error
}

function itemGlyph(state: AttentionInboxItem["state"]): string {
  if (state === "permission_needed") return "?"
  if (state === "turn_complete") return "✓"
  if (state === "rate_limited") return "⌛"
  return "!"
}

function tabLabel(
  item: AttentionInboxItem,
  task: Task | undefined,
  kv: KVContext,
): { label: string; available: boolean } {
  const tab = item.tabId ? knownTaskTab(kv, item.taskId, item.tabId) : undefined
  return {
    label: tab ? tabTitle(tab, task?.vendor ?? DEFAULT_TASK_VENDOR) : (item.tabId ?? ""),
    available: isAttentionInboxItemAvailable(item, task, () => tab !== undefined),
  }
}

export function AttentionInboxPane(props: {
  items: readonly AttentionInboxItem[]
  tasks: readonly Task[]
  kv: KVContext
  onOpen: (item: AttentionInboxItem, available: boolean) => void
  onDelete: (item: AttentionInboxItem) => void
  onClose: () => void
}) {
  const { theme } = useTheme()
  const t = useT()
  const dimensions = useTerminalDimensions()
  const [cursor, setCursor] = useState(0)
  const taskOrder = props.tasks.map((task) => task.id)
  const ordered = sortAttentionInbox(props.items, taskOrder)
  const maxRows = Math.max(1, Math.min(MAX_DIALOG_ROWS, dimensions.height - 8))
  const safeCursor = Math.min(cursor, Math.max(0, ordered.length - 1))
  const windowStart = Math.max(0, Math.min(safeCursor - maxRows + 1, ordered.length - maxRows))
  const visible = ordered.slice(windowStart, windowStart + maxRows)

  useEffect(() => {
    if (cursor !== safeCursor) setCursor(safeCursor)
  }, [cursor, safeCursor])

  function move(delta: 1 | -1): void {
    if (ordered.length === 0) return
    setCursor((current) => (current + delta + ordered.length) % ordered.length)
  }

  function selected(): AttentionInboxItem | undefined {
    return ordered[safeCursor]
  }

  function open(item: AttentionInboxItem): void {
    const task = props.tasks.find((candidate) => candidate.id === item.taskId)
    props.onOpen(item, tabLabel(item, task, props.kv).available)
  }

  useBindings(() => ({
    bindings: bindByIds({
      "inbox.nav": (_event, slot) => move((slot ?? 0) % 2 === 0 ? 1 : -1),
      "inbox.open": () => {
        const item = selected()
        if (item) open(item)
      },
      "inbox.delete": () => {
        const item = selected()
        if (item) props.onDelete(item)
      },
    }),
  }))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} justifyContent="space-between">
        <box flexDirection="row">
          <text fg={theme.focusAccent} attributes={TextAttributes.BOLD} wrapMode="none">
            {t("workspace.inbox.title")}
          </text>
          <text fg={theme.textMuted} wrapMode="none">{` ${ordered.length}`}</text>
        </box>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={props.onClose}>
          esc
        </text>
      </box>
      {ordered.length === 0 ? (
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("workspace.inbox.empty")}
          </text>
        </box>
      ) : (
        <box flexDirection="column" paddingTop={1} paddingBottom={1}>
          {visible.map((item, index) => {
            const absoluteIndex = windowStart + index
            const active = absoluteIndex === safeCursor
            const task = props.tasks.find((candidate) => candidate.id === item.taskId)
            const tab = tabLabel(item, task, props.kv)
            const title = task?.title ?? item.taskId
            return (
              <box
                key={attentionInboxKey(item)}
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active ? theme.backgroundElement : undefined}
                onMouseUp={(event: { stopPropagation(): void }) => {
                  event.stopPropagation()
                  setCursor(absoluteIndex)
                  props.onOpen(item, tab.available)
                }}
              >
                <text fg={theme.focusAccent} wrapMode="none">
                  {item.unread ? "• " : "  "}
                </text>
                <text fg={itemColor(item.state, theme)} wrapMode="none">{`${itemGlyph(item.state)} `}</text>
                <text fg={tab.available ? theme.text : theme.textMuted} wrapMode="none">
                  {`${title}${tab.label ? ` · ${tab.label}` : ""}${tab.available ? "" : ` · ${t("workspace.inbox.unavailable")}`}`}
                </text>
              </box>
            )
          })}
        </box>
      )}
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme.textMuted} wrapMode="none">
          {t("workspace.inbox.openHint")}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {t("workspace.inbox.deleteHint")}
        </text>
      </box>
    </box>
  )
}

export type AttentionInboxDialogProps = {
  orchestrator: RemoteOrchestrator
  onOpen: (item: AttentionInboxItem, available: boolean) => void
  onDelete: (item: AttentionInboxItem) => void
}

export function AttentionInboxDialog(props: AttentionInboxDialogProps) {
  const dialog = useDialog()
  const kv = useKV()
  const items = useAccessor(props.orchestrator.attentionInboxSignal())
  const tasks = useAccessor(props.orchestrator.tasksSignal())
  return (
    <AttentionInboxPane
      items={items}
      tasks={tasks}
      kv={kv}
      onOpen={props.onOpen}
      onDelete={props.onDelete}
      onClose={() => dialog.clear()}
    />
  )
}

AttentionInboxDialog.show = (dialog: DialogContext, props: AttentionInboxDialogProps): void => {
  dialog.replace(() => <AttentionInboxDialog {...props} />)
  dialog.setSize("medium")
  dialog.setPlacement("upper-fifth")
}
