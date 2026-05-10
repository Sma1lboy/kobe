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
import { For, Show, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { Loading } from "./Loading"
import { Markdown } from "./Markdown"
import {
  BASH_OUTPUT_COLLAPSED_CAP,
  type BashInputView,
  type BashOutputView,
  readBashInput,
  splitBashOutput,
} from "./bash-render"
import {
  COMMAND_ARGS_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  extractTag,
} from "./composer/xml-tags"
import {
  COLLAPSED_LINE_CAP,
  type FormattedDiff,
  type FormattedMultiEditDiff,
  capLines,
  formatEditDiff,
  formatMultiEditDiff,
  formatWriteDiff,
} from "./edit-diff"
import type { ChatRow } from "./store"
import { summarizeGlob, summarizeGrep, summarizeRead } from "./tool-banners"

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
  /**
   * Wall-clock ms timestamp marking the start of the current turn.
   * Threaded through to {@link Loading} so the spinner can render
   * `(2m 41s · ↓ 2.0k tokens)` like Claude Code.
   */
  thinkingStartedAt?: number
  /** Chars of assistant text streamed so far this turn (for token est). */
  thinkingResponseChars?: number
  /** Optional banner-state error message. Renders below the list. */
  error: string | null
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
  // Parse claude-code's XML wrappers — `<command-name>` / `<command-args>`
  // for user-typed slash commands, `<local-command-stdout>` / -stderr for
  // their results. Renderers below mirror refs/claude-code/src/components/
  // messages/UserLocalCommandOutputMessage.tsx so the visual language is
  // exactly claude-code's: `/cmd args` chip + `⎿` indented body.
  const parsed = () => {
    const text = props.text
    const cmd = extractTag(text, COMMAND_NAME_TAG)
    if (cmd) {
      const args = extractTag(text, COMMAND_ARGS_TAG) ?? ""
      return { kind: "command" as const, command: cmd, args }
    }
    const stdout = extractTag(text, LOCAL_COMMAND_STDOUT_TAG)
    const stderr = extractTag(text, LOCAL_COMMAND_STDERR_TAG)
    if (stdout || stderr) {
      return { kind: "command-output" as const, stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? "" }
    }
    return { kind: "plain" as const, text }
  }
  const view = parsed()
  if (view.kind === "command") {
    return (
      <box paddingTop={1} flexDirection="row" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          &gt;
        </text>
        <box flexGrow={1} flexDirection="row" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
            {view.command}
          </text>
          {view.args ? (
            <text fg={theme.textMuted} wrapMode="none">
              {view.args}
            </text>
          ) : null}
        </box>
      </box>
    )
  }
  if (view.kind === "command-output") {
    // claude-code's convention: indent under a `⎿` rule glyph in textMuted.
    // Empty content (NO_CONTENT_MESSAGE) is rendered as a dim "(no content)"
    // line so the user sees the slash actually executed and produced
    // nothing instead of a totally blank chat row.
    const hasAny = view.stdout.length > 0 || view.stderr.length > 0
    return (
      <box paddingTop={1} flexDirection="column">
        {hasAny ? (
          <>
            {view.stdout ? (
              <box flexDirection="row">
                <text fg={theme.textMuted}>{"  ⎿  "}</text>
                <box flexGrow={1}>
                  <text fg={theme.text}>{view.stdout}</text>
                </box>
              </box>
            ) : null}
            {view.stderr ? (
              <box flexDirection="row">
                <text fg={theme.textMuted}>{"  ⎿  "}</text>
                <box flexGrow={1}>
                  <text fg={theme.error}>{view.stderr}</text>
                </box>
              </box>
            ) : null}
          </>
        ) : (
          <text fg={theme.textMuted}>(no content)</text>
        )}
      </box>
    )
  }
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        &gt;
      </text>
      <box flexGrow={1}>
        <text fg={theme.text}>{view.text}</text>
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
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
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
  // Edit/Write/MultiEdit get a custom inline-diff renderer (lifted from
  // refs/claude-code/src/components/FileEditToolUpdatedMessage.tsx +
  // MultiEditToolUseMessage.tsx). For these, the chip-style
  // `(arg-preview)` would be a jumbled JSON blob and the `⎿ File
  // created…` result line is redundant noise — the diff IS the preview.
  const isDiffTool = () => r().name === "Edit" || r().name === "Write"
  const isMultiEdit = () => r().name === "MultiEdit"
  // Bash/Read/Grep/Glob are "purpose-built banner" tools. Each one paints
  // its own custom banner line (no JSON-ish chip), and Bash also paints
  // a stdout/stderr block under it. They all share the property that the
  // generic `(arg-preview)` isn't useful and either replaces or augments
  // the default `⎿ <output>` preview line.
  const isBash = () => r().name === "Bash"
  const isReadGrepGlob = () => r().name === "Read" || r().name === "Grep" || r().name === "Glob"
  /** Tools whose banner replaces the generic `tool(arg-preview)` chip. */
  const usesCustomBanner = () => isDiffTool() || isMultiEdit() || isBash() || isReadGrepGlob()
  /** Tools whose body renders inline so the generic preview/expanded
   *  blocks below should be suppressed. */
  const usesCustomBody = () => isDiffTool() || isMultiEdit() || isBash()
  const diff = (): FormattedDiff | null => {
    if (r().name === "Edit") return formatEditDiff(r().input)
    if (r().name === "Write") return formatWriteDiff(r().input)
    return null
  }
  const multiDiff = (): FormattedMultiEditDiff | null => (isMultiEdit() ? formatMultiEditDiff(r().input) : null)
  return (
    <box paddingTop={1} flexDirection="column">
      {/* Banner: prefix + tool name + (one-line args). For tools with
          custom banners (Edit/Write/MultiEdit/Bash/Read/Grep/Glob) the
          parenthesised JSON-ish blob is suppressed and the row paints
          its own banner content below the prefix. */}
      <box flexDirection="row" gap={1} onMouseUp={() => props.onToggle()}>
        <text fg={prefixColor()} attributes={TextAttributes.BOLD}>
          {prefixGlyph()}
        </text>
        <box flexGrow={1}>
          <Show
            when={isReadGrepGlob()}
            fallback={
              <Show
                when={isBash()}
                fallback={
                  <text fg={theme.text}>
                    <span style={{ attributes: TextAttributes.BOLD }}>{r().name}</span>
                    <Show when={!usesCustomBanner()}>
                      <span style={{ fg: theme.textMuted }}>({previewToolInput(r().input)})</span>
                    </Show>
                  </text>
                }
              >
                <BashBanner row={r()} />
              </Show>
            }
          >
            <ReadGrepGlobBanner row={r()} />
          </Show>
        </box>
      </box>
      {/* Edit/Write inline diff — header + colored line list. Renders
          in both collapsed and expanded states; only the per-side line
          cap differs. */}
      <Show when={isDiffTool() && diff()}>
        <EditWriteDiffBlock diff={diff() as FormattedDiff} expanded={props.expanded} onToggle={props.onToggle} />
      </Show>
      {/* MultiEdit — shared header + per-edit mini-diff stack. */}
      <Show when={isMultiEdit() && multiDiff()}>
        <MultiEditDiffBlock
          diff={multiDiff() as FormattedMultiEditDiff}
          expanded={props.expanded}
          onToggle={props.onToggle}
        />
      </Show>
      {/* Bash output block — collapsed shows a 10-line head, expanded
          shows the full payload. Suppressed entirely for in-flight
          Bash calls (no output to render yet) and for empty output. */}
      <Show when={isBash() && r().done}>
        <BashOutputBlock output={r().output} expanded={props.expanded} onToggle={props.onToggle} />
      </Show>
      {/* Result preview — collapsed view shows one indented line.
          Suppressed for tools with custom bodies (Edit/Write/MultiEdit/
          Bash) and for the banner-only tools (Read/Grep/Glob) which
          fold the result count into the banner itself. */}
      <Show when={!usesCustomBody() && !isReadGrepGlob() && !props.expanded && r().done && r().output !== undefined}>
        <box paddingLeft={2} flexDirection="row" onMouseUp={() => props.onToggle()}>
          <text fg={theme.textMuted}>
            {RESULT_PREFIX}
            {previewToolOutput(r().output)}
          </text>
        </box>
      </Show>
      {/* Expanded view — full input + output. Skipped for tools with
          custom bodies; for Read/Grep/Glob the expanded view still
          shows the raw output dump (useful when the user wants the
          full file contents / search results), but skips the input
          block since the banner already shows it. */}
      <Show when={!usesCustomBody() && !isReadGrepGlob() && props.expanded}>
        <box paddingLeft={2} flexDirection="column" paddingTop={0}>
          <text fg={theme.textMuted}>input:</text>
          <text fg={theme.text}>{safeStringify(r().input)}</text>
          <Show when={r().done}>
            <text fg={theme.textMuted}>output:</text>
            <text fg={theme.text}>{safeStringify(r().output)}</text>
          </Show>
        </box>
      </Show>
      <Show when={isReadGrepGlob() && props.expanded && r().done}>
        <box paddingLeft={2} flexDirection="column" paddingTop={0}>
          <text fg={theme.textMuted}>output:</text>
          <text fg={theme.text}>{safeStringify(r().output)}</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Inline diff body for Edit/Write tool rows. Lifted (visual structure
 * only) from `refs/claude-code/src/components/FileEditToolUpdatedMessage.tsx`:
 * a header line ("Added 3 lines, removed 1 line") followed by the diff
 * lines in two color zones (red/diffRemoved for `-`, green/diffAdded
 * for `+`).
 *
 * The collapsed render caps each side at {@link COLLAPSED_LINE_CAP}
 * lines, appending a dim `… N more lines` row when truncated. Expanded
 * shows the full set. Click anywhere on the block toggles.
 *
 * Background tint mirrors `src/tui/panes/preview/DiffLine.tsx` so the
 * chat's inline diff visually matches the Preview pane's `/diff` view —
 * a user moving their eye between the two surfaces sees the same
 * vocabulary.
 */
function EditWriteDiffBlock(props: { diff: FormattedDiff; expanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const cap = () => (props.expanded ? -1 : COLLAPSED_LINE_CAP)
  const removes = () => capLines(props.diff.removes, cap())
  const adds = () => capLines(props.diff.adds, cap())
  return (
    <box paddingLeft={2} flexDirection="column" onMouseUp={() => props.onToggle()}>
      <text fg={theme.textMuted}>
        {RESULT_PREFIX}
        {props.diff.header}
      </text>
      <For each={removes().visible}>
        {(line) => (
          <box backgroundColor={theme.diffRemovedBg} paddingLeft={1} paddingRight={1}>
            <text fg={theme.diffRemoved} wrapMode="none">
              {`- ${line}` || " "}
            </text>
          </box>
        )}
      </For>
      <Show when={removes().hidden > 0}>
        <text fg={theme.textMuted}>
          {`  … ${removes().hidden} more removed ${removes().hidden === 1 ? "line" : "lines"}`}
        </text>
      </Show>
      <For each={adds().visible}>
        {(line) => (
          <box backgroundColor={theme.diffAddedBg} paddingLeft={1} paddingRight={1}>
            <text fg={theme.diffAdded} wrapMode="none">
              {`+ ${line}` || " "}
            </text>
          </box>
        )}
      </For>
      <Show when={adds().hidden > 0}>
        <text fg={theme.textMuted}>{`  … ${adds().hidden} more added ${adds().hidden === 1 ? "line" : "lines"}`}</text>
      </Show>
    </box>
  )
}

/**
 * Inline diff body for MultiEdit tool rows. Lifted (visual structure
 * only) from `refs/claude-code/src/components/messages/MultiEditToolUseMessage.tsx`:
 * a shared header with the file path + total counts, then a stack of
 * mini-diffs — one per `{old_string, new_string}` pair, separated by a
 * thin dim divider so the eye can tell where one hunk ends and the next
 * begins.
 *
 * In the collapsed view we cap *each* hunk independently at
 * {@link COLLAPSED_LINE_CAP} lines so a 50-edit MultiEdit doesn't blow
 * up the chat — the user sees the first cap-many lines of each hunk
 * with the usual `… N more lines` tail. Expanded shows everything.
 */
function MultiEditDiffBlock(props: {
  diff: FormattedMultiEditDiff
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const cap = () => (props.expanded ? -1 : COLLAPSED_LINE_CAP)
  return (
    <box paddingLeft={2} flexDirection="column" onMouseUp={() => props.onToggle()}>
      <text fg={theme.textMuted}>
        {RESULT_PREFIX}
        {props.diff.header}
      </text>
      <For each={props.diff.edits}>
        {(edit, i) => {
          const removes = capLines(edit.removes, cap())
          const adds = capLines(edit.adds, cap())
          const isFirst = i() === 0
          return (
            <box flexDirection="column">
              {/* Thin divider between consecutive edits — same dim
                  textMuted glyph as the result-preview corner so the
                  block reads as one continuous tool result. */}
              <Show when={!isFirst}>
                <text fg={theme.textMuted}>{"  ─"}</text>
              </Show>
              <For each={removes.visible}>
                {(line) => (
                  <box backgroundColor={theme.diffRemovedBg} paddingLeft={1} paddingRight={1}>
                    <text fg={theme.diffRemoved} wrapMode="none">
                      {`- ${line}` || " "}
                    </text>
                  </box>
                )}
              </For>
              <Show when={removes.hidden > 0}>
                <text fg={theme.textMuted}>
                  {`  … ${removes.hidden} more removed ${removes.hidden === 1 ? "line" : "lines"}`}
                </text>
              </Show>
              <For each={adds.visible}>
                {(line) => (
                  <box backgroundColor={theme.diffAddedBg} paddingLeft={1} paddingRight={1}>
                    <text fg={theme.diffAdded} wrapMode="none">
                      {`+ ${line}` || " "}
                    </text>
                  </box>
                )}
              </For>
              <Show when={adds.hidden > 0}>
                <text fg={theme.textMuted}>
                  {`  … ${adds.hidden} more added ${adds.hidden === 1 ? "line" : "lines"}`}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

/**
 * Bash banner — `$ <command>` (accent `$`) plus an optional dim
 * `# <description>` annotation. Shape lifted from
 * `refs/claude-code/src/components/messages/BashToolUseMessage.tsx`.
 *
 * The banner replaces the generic `Bash({...})` chip so the user reads
 * the command directly without parsing JSON. Description is only
 * rendered when the model supplies one (most production Bash calls
 * skip it).
 */
function BashBanner(props: { row: Extract<ChatRow, { kind: "tool" }> }) {
  const { theme } = useTheme()
  const view = (): BashInputView => readBashInput(props.row.input)
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          $
        </text>
        <box flexGrow={1}>
          <text fg={theme.text} wrapMode="none">
            {view().command || "(no command)"}
          </text>
        </box>
      </box>
      <Show when={view().description}>
        <text fg={theme.textMuted} wrapMode="none">
          {`  # ${view().description}`}
        </text>
      </Show>
    </box>
  )
}

/**
 * Bash output block — collapsed renders a {@link BASH_OUTPUT_COLLAPSED_CAP}
 * line preview with the usual `… N more lines` tail; expanded shows the
 * full payload. Lifted from upstream's command-output rendering shape
 * (refs/claude-code/src/components/messages/BashToolUseMessage.tsx —
 * `<Box flexDirection="column">` with each line as its own `<Text>`).
 *
 * We don't have separate stderr from the engine event stream — the
 * orchestrator combines stdout+stderr into one `output` string per
 * tool result — so this is one block. If/when the orchestrator starts
 * shipping stderr separately, add a second BashOutputBlock after this
 * one in `theme.error`.
 */
function BashOutputBlock(props: { output: unknown; expanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const view = (): BashOutputView => splitBashOutput(props.output, props.expanded ? -1 : BASH_OUTPUT_COLLAPSED_CAP)
  return (
    <Show when={view().totalLines > 0}>
      <box paddingLeft={2} flexDirection="column" onMouseUp={() => props.onToggle()}>
        <For each={view().visible}>
          {(line) => (
            <text fg={theme.textMuted} wrapMode="none">
              {line || " "}
            </text>
          )}
        </For>
        <Show when={view().hidden > 0}>
          <text fg={theme.textMuted}>{`  … ${view().hidden} more ${view().hidden === 1 ? "line" : "lines"}`}</text>
        </Show>
      </box>
    </Show>
  )
}

/**
 * Banner for Read / Grep / Glob — three "search/inspect" tools whose
 * args are short enough to show inline. Shape lifted from upstream's
 * per-tool messages (`ReadToolUseMessage.tsx`, `GrepToolUseMessage.tsx`,
 * `GlobToolUseMessage.tsx`): bold tool name + a dim arg/result summary.
 *
 * - Read:  `Read <file> · L<start>-<end>` (range omitted when absent).
 * - Grep:  `Grep "<pattern>" · <N matches>` (count parsed from output
 *          when the result is a count-style string; otherwise dim
 *          `<truncated>` is shown so the user knows there's content
 *          they can expand).
 * - Glob:  `Glob "<pattern>" · <N files>`.
 */
function ReadGrepGlobBanner(props: { row: Extract<ChatRow, { kind: "tool" }> }) {
  const { theme } = useTheme()
  const r = () => props.row
  const summary = (): string => {
    if (r().name === "Read") return summarizeRead(r().input)
    if (r().name === "Grep") return summarizeGrep(r().input, r().output, r().done)
    if (r().name === "Glob") return summarizeGlob(r().input, r().output, r().done)
    return ""
  }
  return (
    <text fg={theme.text} wrapMode="none">
      <span style={{ attributes: TextAttributes.BOLD }}>{r().name}</span>
      <Show when={summary().length > 0}>
        <span style={{ fg: theme.textMuted }}>{` ${summary()}`}</span>
      </Show>
    </text>
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
 * Approval row — kobe's host-side rendering of an `ExitPlanMode` plan
 * approval request. Mirrors upstream's `ExitPlanModeTool/UI.tsx`
 * shape (banner + plan path + Markdown body) but adds clickable
 * Approve/Reject buttons since kobe is the host driving the
 * subprocess in `-p` mode and there's no inline-prompt path.
 *
 * Three visual states tied to `row.status`:
 *   - `pending`  — warning-colored banner + buttons.
 *   - `approved` — success-colored "User approved Claude's plan" header,
 *                  buttons replaced with a static "approved" chip.
 *   - `rejected` — error-colored "Plan rejected" header, "rejected"
 *                  chip. Plan stays visible so the user can scroll back.
 */
function ApprovalRow(props: {
  row: Extract<ChatRow, { kind: "approval" }>
  onApprove: (approve: boolean) => void
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const isPending = () => r().status === "pending"

  const headerText = () => {
    if (r().status === "approved") return "User approved Claude's plan"
    if (r().status === "rejected") return "User rejected Claude's plan"
    return "Awaiting your approval"
  }
  const headerColor = () => {
    if (r().status === "approved") return theme.success
    if (r().status === "rejected") return theme.error
    return theme.warning
  }
  const headerGlyph = () => {
    if (r().status === "approved") return BLACK_CIRCLE
    if (r().status === "rejected") return BLACK_CIRCLE
    return "◆"
  }

  return (
    <box paddingTop={1} flexDirection="column" gap={0}>
      {/* Banner */}
      <box flexDirection="row" gap={1}>
        <text fg={headerColor()} attributes={TextAttributes.BOLD}>
          {headerGlyph()}
        </text>
        <text fg={headerColor()} attributes={TextAttributes.BOLD}>
          {headerText()}
        </text>
      </box>

      {/* File path (dim, indented like a tool result preview). */}
      <Show when={r().filePath}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>
            {RESULT_PREFIX}Plan file: {r().filePath}
          </text>
        </box>
      </Show>

      {/* Plan body — full Markdown render so headings, lists, code blocks
          all show. Indented under the banner so the row visually groups. */}
      <box paddingLeft={2} paddingTop={1}>
        <Markdown source={r().plan || "(empty plan)"} />
      </box>

      {/* Action area — buttons while pending, terminal chip after. */}
      <box paddingLeft={2} paddingTop={1} flexDirection="row" gap={2}>
        <Show
          when={isPending()}
          fallback={
            <text fg={r().status === "approved" ? theme.success : theme.error} attributes={TextAttributes.BOLD}>
              [{r().status}]
            </text>
          }
        >
          <text fg={theme.success} attributes={TextAttributes.BOLD} onMouseUp={() => props.onApprove(true)}>
            [ Approve ]
          </text>
          <text fg={theme.error} attributes={TextAttributes.BOLD} onMouseUp={() => props.onApprove(false)}>
            [ Reject ]
          </text>
        </Show>
      </box>
    </box>
  )
}

/**
 * Question row — kobe's host-side rendering of an `AskUserQuestion`
 * request. Per question we draw a card with header chip + question
 * text + clickable options (radio for single-select, checkbox for
 * multi-select). A single Submit at the bottom collects all answers
 * and routes them up via `onAnswer`. Once submitted, the row flips
 * to a static "answered" state showing each question's chosen value.
 *
 * Wiring choices:
 *   - Selection state lives in component-local signals (one Set per
 *     question). The store only sees the final answers map, after
 *     Submit.
 *   - Submit is enabled only when every question has ≥1 selection.
 *     Multi-select with zero picks would otherwise leave the model
 *     waiting on an effectively-empty answer.
 *   - Multi-select answer encoding follows upstream: comma-separated
 *     option labels (`"Option A, Option C"`). Single-select is just
 *     the label.
 */
function QuestionRow(props: {
  row: Extract<ChatRow, { kind: "question" }>
  onAnswer: (answers: Record<string, string>) => void
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const isAnswered = () => r().answers !== null

  // Per-question selection state. Keyed by question text so re-renders
  // (e.g. when answers fill in) don't clobber it. Sets are mutated in
  // place but we always replace the wrapping signal value to trigger
  // Solid reactivity.
  const [selections, setSelections] = createSignal<Record<string, ReadonlySet<string>>>({})

  function pickedFor(questionText: string): ReadonlySet<string> {
    return selections()[questionText] ?? new Set<string>()
  }

  function toggle(questionText: string, multi: boolean, label: string): void {
    setSelections((prev) => {
      const cur = new Set(prev[questionText] ?? [])
      if (multi) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        // Single-select: clicking the already-selected option clears
        // it (lets the user "unpick"). Different label replaces.
        if (cur.has(label) && cur.size === 1) {
          cur.clear()
        } else {
          cur.clear()
          cur.add(label)
        }
      }
      return { ...prev, [questionText]: cur }
    })
  }

  const allAnswered = () => {
    for (const q of r().questions) {
      if (pickedFor(q.question).size === 0) return false
    }
    return true
  }

  function submit(): void {
    if (!allAnswered() || isAnswered()) return
    const answers: Record<string, string> = {}
    for (const q of r().questions) {
      const picked = Array.from(pickedFor(q.question))
      // Preserve option order for stable comma-joining (Set iteration
      // order is insertion order in JS, but we re-order to match the
      // original options list so the model sees a deterministic string).
      const ordered = q.options.map((o) => o.label).filter((l) => picked.includes(l))
      answers[q.question] = ordered.join(", ")
    }
    props.onAnswer(answers)
  }

  return (
    <box paddingTop={1} flexDirection="column" gap={0}>
      {/* Banner */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          ◆
        </text>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          {isAnswered() ? "Answered" : "Awaiting your answer"}
        </text>
      </box>

      {/* One card per question. */}
      <For each={r().questions}>
        {(q) => {
          const finalAnswer = () => r().answers?.[q.question] ?? null
          const picked = () => pickedFor(q.question)
          return (
            <box paddingLeft={2} paddingTop={1} flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <Show when={q.header}>
                  <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                    [{q.header}]
                  </text>
                </Show>
                <text fg={theme.text}>{q.question}</text>
                <Show when={q.multiSelect}>
                  <text fg={theme.textMuted}>(pick any)</text>
                </Show>
              </box>
              {/* Answered state: render the chosen value(s) as a single line. */}
              <Show when={isAnswered()}>
                <box paddingLeft={2}>
                  <text fg={theme.success}>
                    {RESULT_PREFIX}
                    {finalAnswer() && finalAnswer()!.length > 0 ? finalAnswer() : "(no answer)"}
                  </text>
                </box>
              </Show>
              {/* Pending state: list options, click to toggle. */}
              <Show when={!isAnswered()}>
                <box paddingLeft={2} flexDirection="column">
                  <For each={q.options}>
                    {(opt) => {
                      const isPicked = () => picked().has(opt.label)
                      const glyph = () => (q.multiSelect ? (isPicked() ? "[x]" : "[ ]") : isPicked() ? "(•)" : "( )")
                      return (
                        <box flexDirection="row" gap={1} onMouseUp={() => toggle(q.question, q.multiSelect, opt.label)}>
                          <text fg={isPicked() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                            {glyph()}
                          </text>
                          <box flexGrow={1} flexDirection="column">
                            <text fg={theme.text}>{opt.label}</text>
                            <Show when={opt.description}>
                              <text fg={theme.textMuted}>{opt.description}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </box>
          )
        }}
      </For>

      {/* Submit (pending) or static chip (answered). */}
      <box paddingLeft={2} paddingTop={1} flexDirection="row" gap={2}>
        <Show
          when={!isAnswered()}
          fallback={
            <text fg={theme.success} attributes={TextAttributes.BOLD}>
              [submitted]
            </text>
          }
        >
          <text
            fg={allAnswered() ? theme.success : theme.textMuted}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => submit()}
          >
            [ Submit ]
          </text>
          <Show when={!allAnswered()}>
            <text fg={theme.textMuted}>(answer all questions to enable)</text>
          </Show>
        </Show>
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
            return (
              <AssistantRow text={row.text} isLast={i === props.lastAssistantIdx} isStreaming={props.isStreaming} />
            )
          if (row.kind === "system") return <SystemRow text={row.text} />
          if (row.kind === "approval") {
            return <ApprovalRow row={row} onApprove={(approve) => props.onApprove?.(row.requestId, approve)} />
          }
          if (row.kind === "question") {
            return <QuestionRow row={row} onAnswer={(answers) => props.onAnswer?.(row.requestId, answers)} />
          }
          // tool row
          return (
            <ToolRow
              row={row}
              index={i}
              expanded={props.expandedToolIndex === i}
              onToggle={() => props.onToggleTool(i)}
            />
          )
        }}
      </For>

      <Show when={props.showThinking}>
        <Loading startedAt={props.thinkingStartedAt} responseChars={props.thinkingResponseChars} />
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
