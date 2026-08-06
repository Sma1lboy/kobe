/** @jsxImportSource @opentui/react */
/** Two real engine-owned ChatTabs presented as one Agent Channel. */

import { engineDisplayName, interactiveEngineCommand } from "@/engine/interactive-command"
import type { AgentChannel, AgentChannelEndpoint } from "@/state/agent-channels"
import { DEFAULT_TASK_VENDOR, type Task } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { type ReactNode, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useAccessor } from "../lib/use-accessor"
import { TerminalTabs } from "./TerminalTabs"
import { knownTaskTab } from "./terminal-tabs-shared"

export function AgentChannelWorkspace(props: {
  channel: AgentChannel
  tasks: readonly Task[]
  orchestrator: RemoteOrchestrator
  focused: boolean
  onRequestFocus: () => void
  onTabVisited?: (taskId: string, tabId: string) => void
  /** Render-test seam; production always uses the real hosted-PTY tabs. */
  TerminalTabsComponent?: typeof TerminalTabs
}): ReactNode {
  const { theme, transparentBackground } = useTheme()
  const t = useT()
  const kv = useKV()
  const [focusedSide, setFocusedSide] = useState<0 | 1>(0)
  const Tabs = props.TerminalTabsComponent ?? TerminalTabs
  const transcriptActivity = useAccessor(props.orchestrator.transcriptActivityStore())
  const engineTabStates = useAccessor(props.orchestrator.engineTabStatesSignal())
  const endpoints = props.channel.endpoints.map((endpoint) => ({
    endpoint,
    task: props.tasks.find((task) => task.id === endpoint.taskId),
  }))
  const complete = endpoints.every(
    (entry) => entry.task && knownTaskTab(kv, entry.endpoint.taskId, entry.endpoint.tabId)?.kind === "engine",
  )
  if (!complete) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>{t("channels.workspace.missing")}</text>
      </box>
    )
  }

  const renderEndpoint = (entry: { endpoint: AgentChannelEndpoint; task: Task | undefined }, side: 0 | 1) => {
    const task = entry.task as Task
    const tab = knownTaskTab(kv, entry.endpoint.taskId, entry.endpoint.tabId)
    const vendor = tab?.kind === "engine" ? (tab.vendor ?? task.vendor ?? DEFAULT_TASK_VENDOR) : DEFAULT_TASK_VENDOR
    const focused = props.focused && focusedSide === side
    return (
      <box
        key={entry.endpoint.taskId}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        {...(side === 1
          ? {
              border: ["left"] as const,
              borderColor: transparentBackground ? theme.border : theme.borderSubtle,
            }
          : { border: false as const })}
        onMouseUp={() => {
          setFocusedSide(side)
          props.onRequestFocus()
        }}
      >
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={focused ? theme.focusAccent : theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
            {engineDisplayName(vendor).toUpperCase()}
          </text>
          <text fg={theme.text} wrapMode="none" flexGrow={1}>
            {task.title}
          </text>
          <text fg={focused ? theme.accent : theme.textMuted} wrapMode="none">
            {focused ? "●" : "○"}
          </text>
        </box>
        <Tabs
          key={`${props.channel.id}:${entry.endpoint.taskId}:${entry.endpoint.tabId}`}
          taskId={task.id}
          worktree={task.worktreePath}
          repo={task.repo}
          taskKind={task.kind}
          command={interactiveEngineCommand(task.vendor, task.modelEffort)}
          vendor={task.vendor ?? DEFAULT_TASK_VENDOR}
          modelEffort={task.modelEffort}
          pinnedTabId={entry.endpoint.tabId}
          focused={focused}
          onRequestFocus={() => {
            setFocusedSide(side)
            props.onRequestFocus()
          }}
          sharedActivity={transcriptActivity?.get(task.worktreePath) ?? null}
          hookTabStates={engineTabStates.get(task.id)}
          taskTitle={task.title}
          onTabVisited={(tabId) => props.onTabVisited?.(task.id, tabId)}
        />
      </box>
    )
  }

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <box flexDirection="row" justifyContent="center" flexShrink={0}>
        <text fg={theme.textMuted} wrapMode="none">
          ── {t("channels.workspace.label")}
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          ⇄
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {" ──"}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {renderEndpoint(endpoints[0], 0)}
        {renderEndpoint(endpoints[1], 1)}
      </box>
    </box>
  )
}
