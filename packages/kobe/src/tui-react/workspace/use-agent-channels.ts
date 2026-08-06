/** Host-side creation and selection flow for cross-task native chat channels. */

import { randomUUID } from "node:crypto"
import { canForkSession, engineDisplayName } from "@/engine/interactive-command"
import {
  AGENT_CHANNELS_KEY,
  type AgentChannel,
  availableAgentChannels,
  createAgentChannel,
  readAgentChannels,
} from "@/state/agent-channels"
import { DEFAULT_TASK_VENDOR, type Task } from "@/types/task"
import { useMemo, useState } from "react"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { TaskChannelPickerDialog } from "../component/task-channel-picker-dialog"
import type { KVContext } from "../context/kv"
import type { useT } from "../i18n"
import type { DialogContext } from "../ui/dialog"
import { forkSourceSessionId } from "./fork-chat-tab"
import { appendTaskForkTab, currentTaskActiveTab, requestTabActivation } from "./terminal-tabs-shared"

export function useAgentChannels(deps: {
  tasks: readonly Task[]
  selectedTask: Task | undefined
  kv: KVContext
  dialog: DialogContext
  t: ReturnType<typeof useT>
  notifyError: (message: string) => void
  onOpen: () => void
}) {
  const { tasks, selectedTask, kv, dialog, t } = deps
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const channels = useMemo(
    () =>
      availableAgentChannels(readAgentChannels(kv.store[AGENT_CHANNELS_KEY]), new Set(tasks.map((task) => task.id))),
    [kv.store, tasks],
  )
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId)

  const openChannel = (channel: AgentChannel): void => {
    for (const endpoint of channel.endpoints) requestTabActivation(endpoint.taskId, endpoint.tabId)
    setSelectedChannelId(channel.id)
    deps.onOpen()
  }

  const leaveChannel = (): void => setSelectedChannelId(null)

  const connectCurrent = (): void => {
    if (!selectedTask) return
    void (async () => {
      const targetTask = await TaskChannelPickerDialog.show(dialog, selectedTask, tasks)
      if (!targetTask) return
      try {
        const shell = defaultShell()
        const sourceTab = currentTaskActiveTab(kv, selectedTask.id, shell)
        const targetTab = currentTaskActiveTab(kv, targetTask.id, shell)
        if (sourceTab.kind !== "engine" || targetTab.kind !== "engine") {
          deps.notifyError(t("channels.toast.engineOnly"))
          return
        }
        const sourceVendor = sourceTab.vendor ?? selectedTask.vendor ?? DEFAULT_TASK_VENDOR
        const targetVendor = targetTab.vendor ?? targetTask.vendor ?? DEFAULT_TASK_VENDOR
        for (const [task, vendor] of [
          [selectedTask, sourceVendor],
          [targetTask, targetVendor],
        ] as const) {
          if (!canForkSession(vendor)) {
            deps.notifyError(t("channels.toast.unsupported", { engine: engineDisplayName(vendor) }))
            return
          }
          if (!task.worktreePath) return
        }
        const [sourceSessionId, targetSessionId] = await Promise.all([
          forkSourceSessionId(sourceTab, sourceVendor, selectedTask.worktreePath),
          forkSourceSessionId(targetTab, targetVendor, targetTask.worktreePath),
        ])
        if (!sourceSessionId) {
          deps.notifyError(t("channels.toast.noSession", { task: selectedTask.title }))
          return
        }
        if (!targetSessionId) {
          deps.notifyError(t("channels.toast.noSession", { task: targetTask.title }))
          return
        }

        const sourceFork = appendTaskForkTab(kv, selectedTask.id, shell, {
          vendor: sourceVendor,
          sourceSessionId,
        })
        const targetFork = appendTaskForkTab(kv, targetTask.id, shell, {
          vendor: targetVendor,
          sourceSessionId: targetSessionId,
        })
        const channel = createAgentChannel({
          id: `channel-${randomUUID()}`,
          createdAt: new Date().toISOString(),
          source: { taskId: selectedTask.id, tabId: sourceFork.tab.id },
          target: { taskId: targetTask.id, tabId: targetFork.tab.id },
        })
        kv.set(AGENT_CHANNELS_KEY, [...readAgentChannels(kv.store[AGENT_CHANNELS_KEY]), channel])
        openChannel(channel)
      } catch (error) {
        deps.notifyError(
          t("channels.toast.failed", { message: error instanceof Error ? error.message : String(error) }),
        )
      }
    })()
  }

  return { channels, selectedChannel, selectedChannelId, openChannel, leaveChannel, connectCurrent }
}
