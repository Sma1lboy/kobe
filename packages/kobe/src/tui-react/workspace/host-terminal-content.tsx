/** @jsxImportSource @opentui/react */
/** Selects the ordinary single-task workspace or the two-endpoint channel. */

import type { AgentChannel } from "@/state/agent-channels"
import type { Task } from "@/types/task"
import type { ReactNode } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { QuickTaskResult } from "../component/quick-task-composer"
import { AgentChannelWorkspace } from "./AgentChannelWorkspace"
import { ShowWorkspace } from "./show-workspace"

export function HostTerminalContent(props: {
  channel?: AgentChannel
  tasks: readonly Task[]
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: boolean
  onRequestFocus: () => void
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
  onEngineSendReady: (send: (text: string) => void) => void
  onDiffTabReady: (open: (relPath: string, label: string, base?: string) => void) => void
  onQuickFork: (repo: string, result: QuickTaskResult) => void
  initialPrompt?: string
  onTabVisited?: (taskId: string, tabId: string) => void
}): ReactNode {
  if (props.channel) {
    return (
      <AgentChannelWorkspace
        channel={props.channel}
        tasks={props.tasks}
        orchestrator={props.orchestrator}
        focused={props.focused}
        onRequestFocus={props.onRequestFocus}
        onTabVisited={props.onTabVisited}
      />
    )
  }
  return (
    <ShowWorkspace
      task={props.task}
      worktree={props.worktree}
      orchestrator={props.orchestrator}
      focused={props.focused}
      onRequestFocus={props.onRequestFocus}
      onEditorTabReady={props.onEditorTabReady}
      onEngineSendReady={props.onEngineSendReady}
      onDiffTabReady={props.onDiffTabReady}
      onQuickFork={props.onQuickFork}
      initialPrompt={props.initialPrompt}
      onTabVisited={props.onTabVisited}
    />
  )
}
