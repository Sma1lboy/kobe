import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import type { PermissionMode } from "../../../types/engine"
import type { BackgroundTaskRow } from "../../component/background-tasks-parts"
import type { Theme } from "../../context/theme"
import { BackgroundRunsLine } from "./BackgroundRunsLine"
import { Composer, type ComposerSlashEntry } from "./Composer"
import { Loading } from "./Loading"
import { MessageList } from "./MessageList"
import type { ChatRow, QueuedPrompt } from "./store"

export interface ChatViewProps {
  readonly theme: Theme
  readonly hasTaskId: boolean
  readonly setScrollRef: (r: ScrollBoxRenderable) => void
  readonly messages: readonly ChatRow[]
  readonly expandedToolIndex: number | null
  readonly onToggleTool: (index: number) => void
  readonly expandedFoldStartIndex: number | null
  readonly onToggleFold: (startIndex: number) => void
  readonly showThinking: boolean
  readonly onApprove: (requestId: string, approve: boolean) => void
  readonly onAnswer: (requestId: string, answers: Record<string, string>) => void
  readonly onClaimComposerFocus: (claim: boolean) => void
  readonly chatFocused: () => boolean
  readonly loadingStartedAt: number | undefined
  readonly currentTurnChars: number
  readonly error: string | null
  readonly showComposer: boolean
  readonly draft: string
  readonly onDraftChange: (value: string) => void
  readonly isStreaming: boolean
  readonly composerHasTask: boolean
  readonly noTaskMessage: string | undefined
  readonly onSubmit: (trimmed: string, mode?: "auto" | "steer") => void
  readonly composerFocused: () => boolean
  readonly historyKey: string | undefined
  readonly slashes: Accessor<readonly ComposerSlashEntry[]>
  readonly permissionMode: Accessor<PermissionMode | undefined>
  readonly permissionModeLabel: Accessor<string>
  readonly onCyclePermissionMode: () => void
  readonly modelLabel: Accessor<string>
  readonly inputPlaceholder: Accessor<string>
  readonly onChooseModel: () => void
  readonly worktreePath: Accessor<string | undefined>
  readonly queue: Accessor<readonly QueuedPrompt[]>
  readonly queuePaused: Accessor<boolean>
  readonly onToggleQueuePause: () => void
  readonly onCancelQueued: (id: string) => void
  readonly onSendQueuedNow: (id: string) => void
  readonly onBashCommand: (command: string) => void
  readonly onOpenFilePath?: (relPath: string) => void
  readonly onEditQueued: (id: string) => void
  readonly editingQueueId: Accessor<string | null>
  readonly taskLabelForHistoryKey?: (historyKey: string) => string | undefined
  readonly currentProjectRoot?: Accessor<string | undefined>
  /**
   * Agent sessions running out of view (running / awaiting_input,
   * excluding this tab). Rendered as a one-line readout above the
   * composer — kobe's analogue of claude-code's `BackgroundTaskStatus`.
   */
  readonly backgroundRows?: Accessor<readonly BackgroundTaskRow[]>
  /** Open the background-tasks dialog (from the background-runs line). */
  readonly onOpenBackgroundTasks?: () => void
}

export function ChatView(props: ChatViewProps) {
  const theme = props.theme
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={!props.hasTaskId}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task or press n to create one.</text>
        </box>
      </Show>

      <Show when={props.hasTaskId}>
        <scrollbox
          ref={props.setScrollRef}
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingRight={1} gap={0}>
            <MessageList
              messages={props.messages}
              expandedToolIndex={props.expandedToolIndex}
              onToggleTool={props.onToggleTool}
              expandedFoldStartIndex={props.expandedFoldStartIndex}
              onToggleFold={props.onToggleFold}
              showEmptyPlaceholder={!props.showThinking}
              onApprove={props.onApprove}
              onAnswer={props.onAnswer}
              onClaimComposerFocus={props.onClaimComposerFocus}
              chatFocused={props.chatFocused}
            />
          </box>
        </scrollbox>
      </Show>

      <Show when={props.showThinking && props.hasTaskId}>
        <Loading startedAt={props.loadingStartedAt} responseChars={props.currentTurnChars} />
      </Show>

      <Show when={props.error}>
        {(err) => (
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundElement}
            flexShrink={0}
          >
            <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
              !
            </text>
            <text fg={theme.warning} wrapMode="none">
              error
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {err()}
            </text>
          </box>
        )}
      </Show>

      <Show when={props.hasTaskId && props.backgroundRows && props.onOpenBackgroundTasks}>
        <BackgroundRunsLine rows={props.backgroundRows!} onActivate={props.onOpenBackgroundTasks!} />
      </Show>

      <Show when={props.showComposer}>
        <Composer
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          isStreaming={props.isStreaming}
          hasTask={props.composerHasTask}
          noTaskMessage={props.noTaskMessage}
          onSubmit={props.onSubmit}
          focused={props.composerFocused}
          historyKey={props.historyKey}
          slashes={props.slashes}
          permissionMode={props.permissionMode}
          permissionModeLabel={props.permissionModeLabel}
          onCyclePermissionMode={props.onCyclePermissionMode}
          modelLabel={props.modelLabel}
          inputPlaceholder={props.inputPlaceholder}
          onChooseModel={props.onChooseModel}
          worktreePath={props.worktreePath}
          queue={props.queue}
          queuePaused={props.queuePaused}
          onToggleQueuePause={props.onToggleQueuePause}
          onCancelQueued={props.onCancelQueued}
          onSendQueuedNow={props.onSendQueuedNow}
          onBashCommand={props.onBashCommand}
          onOpenFilePath={props.onOpenFilePath}
          onEditQueued={props.onEditQueued}
          editingQueueId={props.editingQueueId}
          taskLabelForHistoryKey={props.taskLabelForHistoryKey}
          currentProjectRoot={props.currentProjectRoot}
        />
      </Show>
    </box>
  )
}
