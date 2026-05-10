/**
 * Center column tab strip — chat + open files (per-task).
 *
 * Renders one chip per chat tab plus AT MOST ONE file chip (KOB-20).
 * Each click in the file tree replaces whatever file was previously
 * open. Switching tasks restores the active tab exactly.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor.
 */

import { basename } from "node:path"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show } from "solid-js"
import { type ChatRunState, chatRunStateKey } from "../../orchestrator/core.ts"
import type { ChatTab } from "../../types/task.ts"
import { useTheme } from "../context/theme"

export function CenterTabStrip(props: {
  isChatActive: Accessor<boolean>
  /**
   * The currently-open file path (workspace shows at most one file
   * tab per task — KOB-20). `null` when no file is open. Selecting a
   * different file in the file tree replaces this in place.
   */
  activeFile: Accessor<string | null>
  /**
   * Per-task chat tabs. With multitab, "chat" is no longer a single
   * entry — each tab gets its own chip in this strip alongside the
   * single file chip, so the user has one unified tab navigation.
   * Falls back to a single static "chat" chip when the task has no
   * tabs yet (e.g. before the first runTask).
   */
  chatTabs: Accessor<readonly ChatTab[]>
  activeChatTabId: Accessor<string | null>
  /**
   * The currently-selected task id (or undefined when nothing is
   * selected). Combined with each chat tab's id to look up the live
   * engine state in {@link chatRunState}. When undefined, every chip
   * resolves to idle — there's no task to attribute the run-state to.
   */
  activeTaskId: Accessor<string | undefined>
  /**
   * Per-chat-tab live engine state, keyed by `${taskId}:${tabId}`
   * (compose via {@link chatRunStateKey}). Drives the leading status
   * dot on each chat-tab chip — green when streaming, yellow when the
   * tab is paused on `AskUserQuestion` / `ExitPlanMode`, no dot when
   * idle. Absence of an entry == idle.
   */
  chatRunState: Accessor<ReadonlyMap<string, ChatRunState>>
  onSelectChat: () => void
  onSelectChatTab: (tabId: string) => void
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
}) {
  const { theme } = useTheme()
  /**
   * Display label for a chat tab — falls back to `chat N` where N is
   * the tab's sticky `seq`, NOT its current array index. Closing a
   * middle tab must not renumber surviving tabs.
   */
  const chatTabLabel = (tab: ChatTab) => (tab.title && tab.title.length > 0 ? tab.title : `chat ${tab.seq}`)
  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <Show
        when={props.chatTabs().length > 0}
        fallback={
          // Pre-runTask state — task has no tabs yet (or no task at
          // all). Render the static "chat" chip so the strip isn't
          // empty and the user can still see they're on chat.
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.isChatActive() ? theme.primary : theme.backgroundElement}
            onMouseUp={() => props.onSelectChat()}
          >
            <text
              fg={props.isChatActive() ? theme.selectedListItemText : theme.text}
              attributes={props.isChatActive() ? TextAttributes.BOLD : undefined}
            >
              chat
            </text>
          </box>
        }
      >
        <For each={props.chatTabs()}>
          {(tab, _i) => {
            // A chat tab chip is "active" only when the workspace is on
            // chat AND this is the active chat tab. When chat is open
            // but a different tab is selected, we still want it to look
            // distinct from "chat is hidden behind a file tab" — render
            // the active chat-tab in primary, the inactive chat-tabs in
            // a softer style, and all of them dim when chat isn't the
            // workspace tab at all.
            const isPrimary = () => props.isChatActive() && props.activeChatTabId() === tab.id
            const isVisibleButOther = () => props.isChatActive() && !isPrimary()
            // Live engine state for this chat tab. Resolved through the
            // composite `${taskId}:${tabId}` key so a multi-tab task
            // can show, say, yellow on the asking tab and green on a
            // streaming sibling at the same time.
            const runState = (): ChatRunState | undefined => {
              const taskId = props.activeTaskId()
              if (!taskId) return undefined
              return props.chatRunState().get(chatRunStateKey(taskId, tab.id))
            }
            const dotGlyph = () => {
              const s = runState()
              return s === "running" || s === "awaiting_input" ? "●" : ""
            }
            // The dot's color is the run-state signal — never the
            // chip's selection color. Earlier we tinted it
            // `selectedListItemText` when the chip was primary so it
            // matched the chip text, but that swallowed the live
            // green/yellow signal exactly when Jackson was looking at
            // the active tab and most needed to see whether it was
            // running. The status dot's job overrides the chip's
            // emphasis; green/yellow stay legible on the primary
            // background.
            const dotColor = () => {
              const s = runState()
              if (s === "awaiting_input") return theme.warning
              if (s === "running") return theme.success
              return theme.textMuted
            }
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isPrimary() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  if (!props.isChatActive()) props.onSelectChat()
                  props.onSelectChatTab(tab.id)
                }}
              >
                <Show when={dotGlyph().length > 0}>
                  <text fg={dotColor()} wrapMode="none">
                    {dotGlyph()}
                  </text>
                </Show>
                {/* No leading ordinal — chat tabs cycle via ctrl+[/]
                    rather than ctrl+N, so a digit prefix would
                    misadvertise the chord. */}
                <text
                  fg={isPrimary() ? theme.selectedListItemText : isVisibleButOther() ? theme.text : theme.textMuted}
                  attributes={isPrimary() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {chatTabLabel(tab)}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={props.activeFile()}>
        {(file) => {
          // Single file chip — present iff a file is open. Always rendered
          // as primary while the workspace is on file mode (it's the only
          // file chip, so it's always the active one), muted when chat is
          // showing instead.
          const isActive = () => !props.isChatActive()
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
              onMouseUp={() => props.onSelectFile(file())}
            >
              <text
                fg={isActive() ? theme.selectedListItemText : theme.text}
                attributes={isActive() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {basename(file())}
              </text>
              <text
                fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                onMouseUp={() => queueMicrotask(() => props.onCloseFile(file()))}
              >
                x
              </text>
            </box>
          )
        }}
      </Show>
    </box>
  )
}
