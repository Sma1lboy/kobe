/**
 * Wave 4.B — message list renderer.
 *
 * Goal: kobe's chat should *look* like Claude Code's, so a user moving
 * between the GUI / Ink CLI / kobe doesn't notice the boundary. The
 * conventions ported here come from the leaked Anthropic source under
 * `refs/claude-code/src/components/`:
 *
 *   - `Message.tsx`, `MessageRow.tsx`, `MessageResponse.tsx`
 *   - `messages/AssistantTextMessage.tsx`         (BLACK_CIRCLE prefix
 *                                                  + `<Markdown>` body)
 *   - `messages/AssistantToolUseMessage.tsx`      (banner shape:
 *                                                  prefix + bold name)
 *   - `messages/SystemTextMessage.tsx`            (REFERENCE_MARK / dim)
 *   - `messages/UserPromptMessage.tsx`            (block, optional bg)
 *   - `tasks/renderToolActivity.tsx`              (tool name(args) shape)
 *   - `Spinner/SpinnerGlyph.tsx`                  (spinner glyph set)
 *   - `constants/figures.ts`                      (BLACK_CIRCLE etc.)
 *
 * Visual mapping (Claude Code → kobe):
 *
 *   - Assistant: leading `⏺` (or `●` non-darwin) in `theme.text`,
 *     followed by markdown-rendered body. Streaming cursor `▏` appended
 *     to the trailing assistant row mid-turn. Same as
 *     `AssistantTextMessage` + `Markdown`.
 *   - User prompt: leading `>` chip in `theme.accent`, body in
 *     `theme.text`. Claude Code paints a `userMessageBackground`; we
 *     use the accent `>` chip + plain bg to match agent-deck's
 *     bracket-chip vocabulary kobe already uses elsewhere.
 *   - Tool: prefix glyph + bold tool name + `(arg-preview)`. Status-aware:
 *     spinner glyph while running, `⏺` once done. Indented `⎿` line
 *     for the result preview when collapsed (mirrors `MessageResponse`'s
 *     `⎿` continuation glyph). Expanded mode shows full input/output.
 *   - System / error: `※` reference mark + dim text. Errors use
 *     `theme.error` (mirrors `SystemAPIErrorMessage`'s color).
 *
 * The component is a pure render of `messages` — it does NOT subscribe
 * to orchestrator events, manage focus, or own scroll state. The shell
 * (`Chat.tsx`) provides those concerns + the streaming/error flags.
 *
 * Props are deliberately additive to what Chat.tsx already derives —
 * passing `lastAssistantIdx` saves a re-scan of the list inside this
 * component, and `expandedToolIndex` keeps the toggle state owned by
 * the shell (tool toggles persist across re-renders of MessageList).
 */

import { type Accessor, For, Show, createMemo } from "solid-js"
import { useTheme } from "../../context/theme"
import { AssistantRow, BashRow, ReasoningRow, RecapRow, SystemRow, UserRow } from "./MessageRows"
import { ToolRow } from "./ToolRow"
import { ApprovalRow, QuestionRow } from "./UserInputRows"
import type { ChatRow } from "./store"
import type { SnapshotItem } from "./todo-render"
import { type MessageRenderItem, ToolFoldRow, groupRenderItems, summarizeToolRun } from "./tool-fold"
import { classifyTool } from "./tool-registry"

type RowItem = Extract<MessageRenderItem, { kind: "row" }>
type FoldItem = Extract<MessageRenderItem, { kind: "fold" }>

/** Structural equality for fold items — all fields are primitives. */
function foldItemsEqual(a: FoldItem, b: FoldItem): boolean {
  return (
    a.startIndex === b.startIndex &&
    a.inFlight === b.inFlight &&
    a.counts.search === b.counts.search &&
    a.counts.read === b.counts.read &&
    a.counts.list === b.counts.list &&
    a.counts.bash === b.counts.bash &&
    a.counts.other === b.counts.other
  )
}

export interface MessageListProps {
  /** Chronological list of chat rows. Render in array order. */
  messages: readonly ChatRow[]
  /**
   * Per-row "rounded" snapshot items — `Map<rowIndex, items[]>` keyed
   * by the snapshot row's index in `messages`. Threaded down to
   * `ToolRow` so its `TodoSnapshotBanner / TodoSnapshotBody` show only
   * this round's tasks (the previous round's completed tasks have
   * already been baselined out of the slice). Computed once at the
   * `ChatView` level — see {@link computeRoundedSnapshots}.
   */
  roundedSnapshots: ReadonlyMap<number, readonly SnapshotItem[]>
  /** Index of the tool row currently shown expanded, or null. */
  expandedToolIndex: number | null
  /** Toggle the expand/collapse state for the tool at `index`. */
  onToggleTool: (index: number) => void
  /**
   * `startIndex` of the tool-fold currently expanded, or null. Folds key
   * off their first row's index so the same fold stays open across
   * streaming-induced re-folds. Independent from `expandedToolIndex`:
   * one tool inside a fold can be expanded while the fold itself is
   * also expanded.
   */
  expandedFoldStartIndex: number | null
  /** Toggle the expand/collapse state for the fold at `startIndex`. */
  onToggleFold: (startIndex: number) => void
  /**
   * When true, render an empty placeholder when `messages` is empty.
   * The shell suppresses this when the spinner is showing instead so
   * an in-flight first turn doesn't briefly flash "Type a prompt below."
   */
  showEmptyPlaceholder: boolean
  /**
   * Index of one row to skip rendering, or null. Used by the chat
   * shell to lift a still-pending approval/question picker out of
   * the transcript and render it inline above the composer instead —
   * once resolved the row stops being skipped and shows up here as
   * the "answered" version.
   */
  hideRowIndex?: number | null
  /**
   * Click handler for the Approve/Reject buttons rendered on `approval`
   * rows. The chat shell wraps `Orchestrator.respondToInput` here so
   * MessageList stays orchestrator-agnostic. Optional: tests that don't
   * exercise the approval flow can omit it.
   */
  onApprove?: (requestId: string, approve: boolean) => void
  /**
   * Submit handler for the multi-choice form rendered on `question`
   * rows. `answers` is `questionText → "label"` (or comma-separated
   * labels for multi-select). The chat shell wraps
   * `Orchestrator.respondToInput({kind: "ask_question", answers})`.
   */
  onAnswer?: (requestId: string, answers: Record<string, string>) => void
  /**
   * Reported true while a `QuestionRow`'s inline "Other" input is
   * visible and waiting for keystrokes — the chat shell uses this to
   * release the composer's focus so typing lands in the inline input
   * (otherwise both inputs have `focused={true}` and opentui keeps the
   * composer focused, swallowing every keystroke meant for the
   * picker).
   */
  onClaimComposerFocus?: (claim: boolean) => void
  /**
   * Whether the chat pane currently owns keyboard focus. Forwarded to
   * `QuestionRow` so its bare-letter chords (j/k/space/enter/1-9) only
   * fire when the workspace pane is focused — otherwise typing j in the
   * file tree would get swallowed by the question picker.
   */
  chatFocused?: Accessor<boolean>
}

/**
 * Public entry. Renders the full chronological list + an optional
 * error banner. The shell wraps this in a scrollbox; the thinking
 * spinner lives OUTSIDE this list (pinned above the composer) so it
 * doesn't share scroll position with the transcript — mirrors
 * `refs/claude-code/src/screens/REPL.tsx`'s SpinnerWithVerb placement.
 */
export function MessageList(props: MessageListProps) {
  const { theme } = useTheme()

  // Stable-identity projection of the grouped render items.
  //
  // `groupRenderItems` is pure and allocates fresh wrapper objects on
  // every call. Solid's `<For>` is referentially keyed — fed brand-new
  // wrappers each render it tears down and rebuilds *every* visible row
  // on every streaming event (assistant delta, tool start/result),
  // which opentui then re-lays-out wholesale: the visible "twitch".
  //
  // We reconcile here: a `row` wrapper is reused as-is when its backing
  // `ChatRow` reference and list index are unchanged (the chat store is
  // an immutable reducer, so an unmodified row keeps its reference); a
  // `fold` wrapper is reused when its counts / in-flight / start index
  // all match. Only genuinely-changed items get a fresh reference, so
  // `<For>` recreates just those rows and leaves the rest in place.
  let rowCache = new Map<ChatRow, RowItem>()
  let foldCache = new Map<number, FoldItem>()

  const groupedItems = createMemo<MessageRenderItem[]>(() => {
    const raw = groupRenderItems(props.messages, props.expandedFoldStartIndex)
    const nextRowCache = new Map<ChatRow, RowItem>()
    const nextFoldCache = new Map<number, FoldItem>()
    const out = raw.map((item): MessageRenderItem => {
      if (item.kind === "row") {
        const cached = rowCache.get(item.row)
        const reuse = cached && cached.index === item.index ? cached : item
        nextRowCache.set(item.row, reuse)
        return reuse
      }
      const cached = foldCache.get(item.startIndex)
      const reuse = cached && foldItemsEqual(cached, item) ? cached : item
      nextFoldCache.set(item.startIndex, reuse)
      return reuse
    })
    rowCache = nextRowCache
    foldCache = nextFoldCache
    return out
  })

  return (
    <box flexDirection="column" gap={0}>
      {/* Empty placeholder — same copy as before so behavior tests
          asserting on substring "Type a prompt below" still pass. */}
      <Show when={props.messages.length === 0 && props.showEmptyPlaceholder}>
        <box paddingTop={2}>
          <text fg={theme.textMuted}>Type a prompt below.</text>
        </box>
      </Show>

      <For each={groupedItems()}>
        {(item) => {
          if (item.kind === "fold") {
            const startIndex = item.startIndex
            const inFlight = item.inFlight > 0
            return (
              <ToolFoldRow
                summary={summarizeToolRun(item.counts, inFlight)}
                expanded={props.expandedFoldStartIndex === startIndex}
                inFlight={inFlight}
                onToggle={() => props.onToggleFold(startIndex)}
              />
            )
          }
          const row = item.row
          const i = item.index
          if (props.hideRowIndex != null && i === props.hideRowIndex) return null
          if (row.kind === "user") return <UserRow text={row.text} />
          if (row.kind === "assistant") return <AssistantRow text={row.text} />
          if (row.kind === "reasoning") return <ReasoningRow text={row.text} />
          if (row.kind === "system") return <SystemRow text={row.text} />
          if (row.kind === "recap") return <RecapRow text={row.text} />
          if (row.kind === "bash") return <BashRow row={row} />
          if (row.kind === "approval") {
            return <ApprovalRow row={row} onApprove={(approve) => props.onApprove?.(row.requestId, approve)} />
          }
          if (row.kind === "question") {
            return (
              <QuestionRow
                row={row}
                onAnswer={(answers) => props.onAnswer?.(row.requestId, answers)}
                onClaimComposerFocus={props.onClaimComposerFocus}
                chatFocused={props.chatFocused}
              />
            )
          }
          // tool row
          return (
            <ToolRow
              row={row}
              index={i}
              expanded={props.expandedToolIndex === i}
              roundedItems={props.roundedSnapshots.get(i)}
              onToggle={() => props.onToggleTool(i)}
            />
          )
        }}
      </For>
    </box>
  )
}

export { classifyTool, groupRenderItems, summarizeToolRun }
