import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { type Accessor, createMemo } from "solid-js"
import { Show } from "solid-js"
import type { PermissionMode } from "../../../types/engine"
import type { Theme } from "../../context/theme"
import { AgentsView } from "./AgentsView"
import type { AgentRow } from "./agents-view-parts"
import { Composer, type ComposerSlashEntry } from "./Composer"
import { Loading } from "./Loading"
import { MessageList } from "./MessageList"
import { TodoStatusLine } from "./TodoStatusLine"
import type { ChatRow, QueuedPrompt } from "./store"
import { computeRoundedSnapshots } from "./todo-render"

export type ChatPaneMode = "chat" | "agents"

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
   * Agents-mode toggle state + handlers (KOB-209). The chip row above
   * the body switches between Chat (normal transcript) and Agents
   * (per-task tab overview). Composer stays mounted in both modes —
   * in Agents mode submit spawns a new tab.
   */
  readonly chatMode: Accessor<ChatPaneMode>
  readonly onSetChatMode: (mode: ChatPaneMode) => void
  /** Projected Agents-mode rows. Only consumed when chatMode === "agents". */
  readonly agentRows: Accessor<readonly AgentRow[]>
  /** Click a card in Agents mode — selects that tab + flips back to Chat. */
  readonly onSelectAgentTab: (tabId: string) => void
}

export function ChatView(props: ChatViewProps) {
  const theme = props.theme
  const inChat = () => props.chatMode() === "chat"
  const inAgents = () => props.chatMode() === "agents"
  // Cross-row "rounded" snapshots — `Map<rowIndex, items[]>` where each
  // entry is the slice of the snapshot row's items that belong to its
  // round (older rounds filtered out). Computed once here and threaded
  // into MessageList (for inline ToolRow rendering) and TodoStatusLine
  // (for the composer-pinned panel) so both surfaces agree on what
  // counts as "this round" without duplicating the scan.
  const roundedSnapshots = createMemo(() => computeRoundedSnapshots(props.messages))
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={!props.hasTaskId}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task or press n to create one.</text>
        </box>
      </Show>

      <Show when={props.hasTaskId}>
        <ModeChipRow
          theme={theme}
          mode={props.chatMode}
          agentCount={() => props.agentRows().length}
          onSelect={props.onSetChatMode}
        />
      </Show>

      <Show when={props.hasTaskId && inChat()}>
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
              roundedSnapshots={roundedSnapshots()}
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
            {/* Loading spinner + todo panel live **inside** the scrollbox
                so they flow with the transcript instead of being pinned
                above the composer. They land right after the last
                message row, scroll with the chat, and disappear when
                their visibility predicates flip — matches Claude Code
                where the spinner + `TaskListV2` block scrolls with the
                conversation rather than docking to the input bar. */}
            <Show when={props.showThinking && props.hasTaskId}>
              <Loading startedAt={props.loadingStartedAt} responseChars={props.currentTurnChars} />
            </Show>
            <Show when={props.hasTaskId}>
              <TodoStatusLine messages={props.messages} roundedSnapshots={roundedSnapshots()} />
            </Show>
          </box>
        </scrollbox>
      </Show>

      <Show when={props.hasTaskId && inAgents()}>
        <AgentsView theme={theme} rows={props.agentRows} onSelectTab={props.onSelectAgentTab} />
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

      <Show when={props.showComposer || inAgents()}>
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

/**
 * Mode switcher (KOB-209) — text-only `view: › Chat   Agents (N)`
 * row above the body. Deliberately *not* a chip-fill style: the chat
 * tab strip directly above (center-tab-strip) already uses solid-fill
 * chips, and stacking two chip rows looked like a single tab bar. A
 * leading `view:` label + `›` active marker reads as a view selector
 * instead of "more tabs". No keybinding — click only for MVP.
 */
function ModeChipRow(props: {
  theme: Theme
  mode: Accessor<ChatPaneMode>
  agentCount: Accessor<number>
  onSelect: (mode: ChatPaneMode) => void
}) {
  const theme = props.theme
  return (
    <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={1}>
      <text fg={theme.textMuted} wrapMode="none">
        view:
      </text>
      <ModeLink theme={theme} active={props.mode() === "chat"} label="Chat" onSelect={() => props.onSelect("chat")} />
      <ModeLink
        theme={theme}
        active={props.mode() === "agents"}
        label={`Agents (${props.agentCount()})`}
        onSelect={() => props.onSelect("agents")}
      />
    </box>
  )
}

function ModeLink(props: { theme: Theme; active: boolean; label: string; onSelect: () => void }) {
  const theme = props.theme
  return (
    <box flexDirection="row" gap={0} onMouseUp={() => props.onSelect()}>
      <text fg={props.active ? theme.accent : theme.textMuted} wrapMode="none">
        {props.active ? "› " : "  "}
      </text>
      <text
        fg={props.active ? theme.accent : theme.textMuted}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        wrapMode="none"
      >
        {props.label}
      </text>
    </box>
  )
}
