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

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Loading } from "./Loading"
import { Markdown } from "./Markdown"
import type { ChatRow } from "./store"

/**
 * Anthropic's Claude brand orange. Hardcoded (not pulled from the
 * theme) because the assistant marker IS the brand — it should stay
 * orange regardless of the user's theme choice. Matches the orange in
 * Claude's logo / docs / favicon.
 */
const CLAUDE_ORANGE = "#d97757"

/**
 * Claude Code's `BLACK_CIRCLE` figure. Source:
 * `refs/claude-code/src/constants/figures.ts:4`. Darwin gets the
 * "media-stop" glyph (visually a filled circle), other platforms get
 * the standard black-circle codepoint, which renders identically.
 */
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●"

/**
 * Reference-mark figure used by Claude Code for system rows. Source:
 * `refs/claude-code/src/constants/figures.ts:28`. We re-use it for
 * kobe's system rows so error formatting matches.
 */
const REFERENCE_MARK = "※"

/**
 * Glyph used by `MessageResponse.tsx` to indent tool-result previews.
 * Source: `refs/claude-code/src/components/MessageResponse.tsx:22`.
 * Renders as a bracket-corner that visually says "this is a child of
 * the line above."
 */
const RESULT_PREFIX = "⎿ "

/**
 * Streaming cursor — Claude Code uses a half-width cursor block on the
 * trailing assistant text while the turn is mid-flight.
 */
const STREAMING_CURSOR = "▏"

export interface MessageListProps {
  /** Chronological list of chat rows. Render in array order. */
  messages: readonly ChatRow[]
  /** True between user submit and `done`/`error`. */
  isStreaming: boolean
  /** Index of the trailing assistant row, or -1. Anchors the cursor. */
  lastAssistantIdx: number
  /** Index of the tool row currently shown expanded, or null. */
  expandedToolIndex: number | null
  /** Toggle the expand/collapse state for the tool at `index`. */
  onToggleTool: (index: number) => void
  /** Whether to show the "thinking" spinner row at the bottom. */
  showThinking: boolean
  /** Optional banner-state error message. Renders below the list. */
  error: string | null
}

/**
 * One-line input preview for tool-call banners. Mirrors
 * `renderToolActivity.tsx`: stringify, collapse whitespace, truncate.
 * The 60-char cap matches what Claude Code's `userFacingToolName(...)`
 * tends to emit for typical Bash / Read / Edit calls.
 */
function previewToolInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return collapseToOneLine(input, 60)
  try {
    return collapseToOneLine(JSON.stringify(input), 60)
  } catch {
    return "<unserializable>"
  }
}

function previewToolOutput(output: unknown): string {
  // 60-char cap mirrors the prior chat render and keeps the G3c
  // behavior test (FULLOUTPUT_SENTINEL_…, 65 chars) green by ensuring
  // the full sentinel never lands in the collapsed preview.
  if (output == null) return ""
  if (typeof output === "string") return collapseToOneLine(output, 60)
  try {
    return collapseToOneLine(JSON.stringify(output), 60)
  } catch {
    return "<unserializable>"
  }
}

function collapseToOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

function safeStringify(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * User prompt row.
 *
 * Claude Code's `UserPromptMessage` paints a subtle `userMessageBg`
 * behind the text; kobe omits the bg (panes already paint
 * theme.background) and uses an accent `>` chip in front instead.
 * The chip mimics the agent-deck bracket-chip vocabulary used by the
 * status bar — kobe-internal consistency over Claude-Code-exact mimicry
 * here, because bg-on-row clashes with our 5-pane layout's per-pane bg.
 */
function UserRow(props: { text: string }) {
  const { theme } = useTheme()
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        &gt;
      </text>
      <box flexGrow={1}>
        <text fg={theme.text}>{props.text}</text>
      </box>
    </box>
  )
}

/**
 * Assistant row.
 *
 * Mirrors `AssistantTextMessage`: BLACK_CIRCLE prefix + Markdown body.
 * Streaming cursor is appended to the LAST assistant row in the list
 * mid-turn; `Markdown` handles inline code / bold / lists / code
 * blocks. The cursor lives outside the markdown so we don't hand it
 * to the parser as a stray glyph.
 */
function AssistantRow(props: { text: string; isLast: boolean; isStreaming: boolean }) {
  const { theme } = useTheme()
  const showCursor = () => props.isLast && props.isStreaming
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      {/* width=2 mirrors `AssistantTextMessage`'s `minWidth={2}` on the
          BLACK_CIRCLE prefix — `⏺` is rendered as a wide-glyph in many
          terminals and bleeds into the body's leading character without
          a reserved column. (Hardcoded width = terminal-grammar fixed
          glyph, per CLAUDE.md flex-first exception.) */}
      <box width={2} flexShrink={0}>
        <text fg={CLAUDE_ORANGE} attributes={TextAttributes.BOLD}>
          {BLACK_CIRCLE}
        </text>
      </box>
      <box flexGrow={1} flexDirection="column">
        <Markdown source={props.text} />
        <Show when={showCursor()}>
          <text fg={theme.textMuted}>{STREAMING_CURSOR}</text>
        </Show>
      </box>
    </box>
  )
}

/**
 * Tool-call row.
 *
 * Banner shape from `AssistantToolUseMessage`: `<prefix> <bold name>(<args>)`.
 * We swap the prefix glyph by status — running tools get a spinner
 * (matches Claude Code's `ToolUseLoader`); finished tools get
 * BLACK_CIRCLE. Click on the row toggles expansion.
 *
 * Collapsed: a `⎿` continuation line shows a one-line output preview.
 * Expanded: full input + output blobs in a paddingLeft block, mirroring
 * MessageResponse's child-indent shape.
 */
function ToolRow(props: {
  row: Extract<ChatRow, { kind: "tool" }>
  index: number
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const prefixGlyph = () => (r().done ? BLACK_CIRCLE : "✻")
  const prefixColor = () => (r().done ? theme.success : theme.warning)
  return (
    <box paddingTop={1} flexDirection="column">
      {/* Banner: prefix + tool name + (one-line args). */}
      <box flexDirection="row" gap={1} onMouseUp={() => props.onToggle()}>
        <text fg={prefixColor()} attributes={TextAttributes.BOLD}>
          {prefixGlyph()}
        </text>
        <box flexGrow={1}>
          <text fg={theme.text}>
            <span style={{ attributes: TextAttributes.BOLD }}>{r().name}</span>
            <span style={{ fg: theme.textMuted }}>({previewToolInput(r().input)})</span>
          </text>
        </box>
      </box>
      {/* Result preview — collapsed view shows one indented line. */}
      <Show when={!props.expanded && r().done && r().output !== undefined}>
        <box paddingLeft={2} flexDirection="row" onMouseUp={() => props.onToggle()}>
          <text fg={theme.textMuted}>
            {RESULT_PREFIX}
            {previewToolOutput(r().output)}
          </text>
        </box>
      </Show>
      {/* Expanded view — full input + output. */}
      <Show when={props.expanded}>
        <box paddingLeft={2} flexDirection="column" paddingTop={0}>
          <text fg={theme.textMuted}>input:</text>
          <text fg={theme.text}>{safeStringify(r().input)}</text>
          <Show when={r().done}>
            <text fg={theme.textMuted}>output:</text>
            <text fg={theme.text}>{safeStringify(r().output)}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

/**
 * System / error row.
 *
 * Mirrors Claude Code's `SystemTextMessage` "away_summary" / API-error
 * shapes: a `※` reference mark in dim, followed by the message in
 * theme.error (errors land here too — the store maps engine `error`
 * events into `kind: "system"` rows prefixed with `error:`).
 */
function SystemRow(props: { text: string }) {
  const { theme } = useTheme()
  const isError = () => props.text.startsWith("error:") || props.text.startsWith("runTask failed")
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
        {REFERENCE_MARK}
      </text>
      <box flexGrow={1}>
        <text fg={isError() ? theme.error : theme.textMuted}>{props.text}</text>
      </box>
    </box>
  )
}

/**
 * Public entry. Renders the full chronological list + the trailing
 * thinking spinner + an optional error banner. The shell wraps this in
 * a scrollbox so all the layout overflow is handled there.
 */
export function MessageList(props: MessageListProps) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0}>
      {/* Empty placeholder — same copy as before so behavior tests
          asserting on substring "Type a prompt below" still pass. */}
      <Show when={props.messages.length === 0 && !props.showThinking}>
        <box paddingTop={2}>
          <text fg={theme.textMuted}>Type a prompt below.</text>
        </box>
      </Show>

      <For each={groupRenderItems(props.messages)}>
        {(item) => {
          if (item.kind === "fold") {
            return <ToolFoldRow summary={summarizeToolRun(item.counts)} />
          }
          const row = item.row
          const i = item.index
          if (row.kind === "user") return <UserRow text={row.text} />
          if (row.kind === "assistant")
            return <AssistantRow text={row.text} isLast={i === props.lastAssistantIdx} isStreaming={props.isStreaming} />
          if (row.kind === "system") return <SystemRow text={row.text} />
          // tool row
          return (
            <ToolRow row={row} index={i} expanded={props.expandedToolIndex === i} onToggle={() => props.onToggleTool(i)} />
          )
        }}
      </For>

      <Show when={props.showThinking}>
        <Loading />
      </Show>

      <Show when={props.error}>
        <box paddingTop={1} flexDirection="row" gap={1}>
          <text fg={theme.error} attributes={TextAttributes.BOLD}>
            {REFERENCE_MARK}
          </text>
          <text fg={theme.error}>error: {props.error}</text>
        </box>
      </Show>
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Tool-run fold — Claude Code parity                                    */
/* --------------------------------------------------------------------- */

/**
 * Compress consecutive runs of finished tool rows into one summary line
 * (Claude Code's "Searched for X patterns, read Y files, ran Z bash
 * commands" pattern — see `refs/claude-code/src/utils/collapseReadSearch.ts`
 * `getSearchReadSummaryText`). We only fold runs where every tool is
 * `done`: an in-progress tool needs to render individually so the user
 * sees the streaming state.
 *
 * Threshold: 3+ consecutive finished tools. Below that, individual
 * banners are still readable.
 */
type ToolCounts = { search: number; read: number; list: number; bash: number; other: number }

type RenderItem =
  | { kind: "row"; row: ChatRow; index: number }
  | { kind: "fold"; counts: ToolCounts; startIndex: number }

const TOOL_FOLD_THRESHOLD = 3

export function groupRenderItems(messages: readonly ChatRow[]): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const row = messages[i]
    if (!row || row.kind !== "tool") {
      if (row) items.push({ kind: "row", row, index: i })
      i++
      continue
    }
    let j = i
    while (j < messages.length && messages[j]?.kind === "tool") j++
    let allDone = true
    for (let k = i; k < j; k++) {
      const r = messages[k]
      if (r?.kind === "tool" && !r.done) {
        allDone = false
        break
      }
    }
    if (j - i >= TOOL_FOLD_THRESHOLD && allDone) {
      const counts: ToolCounts = { search: 0, read: 0, list: 0, bash: 0, other: 0 }
      for (let k = i; k < j; k++) {
        const r = messages[k]
        if (r?.kind !== "tool") continue
        counts[classifyTool(r.name)]++
      }
      items.push({ kind: "fold", counts, startIndex: i })
    } else {
      for (let k = i; k < j; k++) {
        const r = messages[k]
        if (r) items.push({ kind: "row", row: r, index: k })
      }
    }
    i = j
  }
  return items
}

export function classifyTool(name: string): keyof ToolCounts {
  if (name === "Grep") return "search"
  if (name === "Read" || name === "NotebookRead") return "read"
  if (name === "Glob" || name === "LS") return "list"
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "bash"
  return "other"
}

/**
 * "Searched for 5 patterns, read 3 files, ran 10 bash commands" —
 * mirrors Claude Code's `getSearchReadSummaryText` (past tense; we only
 * fold finished runs so the present-tense branch isn't needed). First
 * fragment is capitalised; subsequent fragments stay lowercase to read
 * as a single sentence.
 */
export function summarizeToolRun(c: ToolCounts): string {
  const parts: string[] = []
  if (c.search > 0) {
    const verb = parts.length === 0 ? "Searched" : "searched"
    parts.push(`${verb} for ${c.search} ${c.search === 1 ? "pattern" : "patterns"}`)
  }
  if (c.read > 0) {
    const verb = parts.length === 0 ? "Read" : "read"
    parts.push(`${verb} ${c.read} ${c.read === 1 ? "file" : "files"}`)
  }
  if (c.list > 0) {
    const verb = parts.length === 0 ? "Listed" : "listed"
    parts.push(`${verb} ${c.list} ${c.list === 1 ? "directory" : "directories"}`)
  }
  if (c.bash > 0) {
    const verb = parts.length === 0 ? "Ran" : "ran"
    parts.push(`${verb} ${c.bash} bash ${c.bash === 1 ? "command" : "commands"}`)
  }
  if (c.other > 0) {
    const verb = parts.length === 0 ? "Used" : "used"
    parts.push(`${verb} ${c.other} ${c.other === 1 ? "other tool" : "other tools"}`)
  }
  return parts.join(", ")
}

/**
 * One-line render for a folded run. Same prefix style as a system row
 * (DIM REFERENCE_MARK) so the eye doesn't read it as a tool banner.
 * Expand affordance deferred to a follow-up.
 */
function ToolFoldRow(props: { summary: string }) {
  const { theme } = useTheme()
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
        {REFERENCE_MARK}
      </text>
      <box flexGrow={1}>
        <text fg={theme.textMuted}>{props.summary}</text>
      </box>
    </box>
  )
}
