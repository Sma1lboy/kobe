/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useEffect, useState } from "react"
import type { AttentionInboxItem } from "../../client/remote-orchestrator"
import { tabTitle } from "../../tui/workspace/terminal-tabs-core"
import type { Task } from "../../types/task"
import { DEFAULT_TASK_VENDOR } from "../../types/task"
import { bindByIds } from "../context/keybindings"
import type { KVContext } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { attentionInboxKey, isAttentionInboxItemAvailable, sortAttentionInbox } from "./attention-inbox-core"
import { knownTaskTab } from "./terminal-tabs-shared"

export const ATTENTION_INBOX_HEIGHT = 8
const MAX_ROWS = 4

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
  focused: boolean
  onOpen: (item: AttentionInboxItem) => void
  onDelete: (item: AttentionInboxItem) => void
  onRequestFocus: () => void
}) {
  const { theme } = useTheme()
  const t = useT()
  const [cursor, setCursor] = useState(0)
  const taskOrder = props.tasks.map((task) => task.id)
  const ordered = sortAttentionInbox(props.items, taskOrder)
  const safeCursor = Math.min(cursor, Math.max(0, ordered.length - 1))
  const windowStart = Math.max(0, Math.min(safeCursor - MAX_ROWS + 1, ordered.length - MAX_ROWS))
  const visible = ordered.slice(windowStart, windowStart + MAX_ROWS)

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

  useBindings(() => ({
    enabled: props.focused,
    bindings: bindByIds({
      "inbox.nav": (_event, slot) => move((slot ?? 0) % 2 === 0 ? 1 : -1),
      "inbox.open": () => {
        const item = selected()
        if (item) props.onOpen(item)
      },
      "inbox.delete": () => {
        const item = selected()
        if (item) props.onDelete(item)
      },
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1} onMouseUp={props.onRequestFocus}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={props.focused ? theme.focusAccent : theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("workspace.inbox.title")}
        </text>
        <text fg={theme.textMuted} wrapMode="none">{` ${ordered.length}`}</text>
      </box>
      {ordered.length === 0 ? (
        <box flexGrow={1} paddingLeft={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("workspace.inbox.empty")}
          </text>
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1}>
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
                  props.onRequestFocus()
                  props.onOpen(item)
                }}
              >
                <text fg={itemColor(item.state, theme)} wrapMode="none">{`${itemGlyph(item.state)} `}</text>
                <text fg={tab.available ? theme.text : theme.textMuted} wrapMode="none">
                  {`${title}${tab.label ? ` · ${tab.label}` : ""}${tab.available ? "" : ` · ${t("workspace.inbox.unavailable")}`}`}
                </text>
              </box>
            )
          })}
        </box>
      )}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} gap={1}>
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
