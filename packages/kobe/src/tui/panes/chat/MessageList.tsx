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
import { type Accessor, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { Markdown } from "./Markdown"
import {
  BASH_OUTPUT_COLLAPSED_CAP,
  type BashInputView,
  type BashOutputView,
  readBashInput,
  splitBashOutput,
} from "./bash-render"
import { prettifyPastedImageRefs } from "./composer/image-paste"
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

export interface MessageListProps {
  /** Chronological list of chat rows. Render in array order. */
  messages: readonly ChatRow[]
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
    // Fold ` @<pastedImagesDir>/<uuid>.<ext> ` refs (what `expand` wrote
    // to the engine prompt) back into `[Image #N]` for human eyes. The
    // engine still sees the absolute path on submit and on history
    // recall — this transform is render-only.
    return { kind: "plain" as const, text: prettifyPastedImageRefs(text) }
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
 * No streaming cursor — claude-code's own AssistantTextMessage doesn't
 * paint one either; the spinner row above the composer is the
 * canonical "turn in flight" affordance.
 */
function AssistantRow(props: { text: string }) {
  const { theme } = useTheme()
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
export function ApprovalRow(props: {
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
 * Sentinel label for the auto-added "Other / type your own answer"
 * option in `QuestionRow`. Per the AskUserQuestion tool spec the
 * picker is required to always offer a custom-text escape hatch; we
 * synthesize it on the client side rather than asking the model to
 * include it. Use a non-printable-prefixed string so it can't collide
 * with a real option label even if the model decided to call its
 * option "Other".
 */
const OTHER_SENTINEL = "__kobe_other__"

/**
 * Question row — kobe's host-side rendering of an `AskUserQuestion`
 * request. Per question we draw a card with header chip + question
 * text + clickable options (radio for single-select, checkbox for
 * multi-select), plus an auto-added "Other" row that reveals a
 * free-text input when picked. A single Submit at the bottom collects
 * all answers and routes them up via `onAnswer`. Once submitted, the
 * row flips to a static "answered" state showing each question's
 * chosen value.
 *
 * Wiring choices:
 *   - Selection state lives in component-local signals (one Set per
 *     question). The store only sees the final answers map, after
 *     Submit.
 *   - Submit is enabled only when every question has ≥1 selection
 *     AND, when "Other" is picked, the custom-text input is non-empty.
 *   - Multi-select answer encoding follows upstream: comma-separated
 *     option labels (`"Option A, Option C"`). Single-select is just
 *     the label. When "Other" is picked the user-typed text is what
 *     ends up in the answer string — the sentinel never escapes.
 */
export function QuestionRow(props: {
  row: Extract<ChatRow, { kind: "question" }>
  onAnswer: (answers: Record<string, string>) => void
  /**
   * Called with `true` while any question on this row has the "Other"
   * sentinel picked but the row hasn't been submitted yet, and with
   * `false` otherwise. The chat shell uses this signal to release the
   * composer's `focused` prop so the inline "Other" input can actually
   * receive keystrokes — without this, both inputs claim focus and the
   * composer wins. Cleaned up on unmount so a row scrolling off-screen
   * doesn't leave the composer perpetually defocused.
   */
  onClaimComposerFocus?: (claim: boolean) => void
  /**
   * Whether the chat pane owns focus right now. Gates this row's
   * keyboard chords so j/k/space/enter/1-9 don't bleed into other
   * panes' bare-letter handlers (file tree j/k, etc.) while a question
   * is queued. Defaults to `() => true` for callers that don't wire it
   * (tests, host-mode), preserving the pre-keyboard behavior.
   */
  chatFocused?: Accessor<boolean>
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const isAnswered = () => r().answers !== null

  // Per-question selection state. Keyed by question text so re-renders
  // (e.g. when answers fill in) don't clobber it. Sets are mutated in
  // place but we always replace the wrapping signal value to trigger
  // Solid reactivity.
  const [selections, setSelections] = createSignal<Record<string, ReadonlySet<string>>>({})

  // Per-question custom-text buffer for the auto-added "Other" option.
  // Only consulted when the OTHER_SENTINEL is in that question's
  // selection set; otherwise irrelevant. Newlines stripped on input
  // because opentui's <input> happily inserts a literal \n on enter
  // even though enter also fires onSubmit (same quirk handled in
  // new-task-dialog/state.ts:stripNewlines).
  const [otherText, setOtherText] = createSignal<Record<string, string>>({})

  // Index of the question the user is currently working on. Questions
  // before this are "locked in" (still editable by clicking) and shown
  // collapsed with their captured answer; questions after this are
  // completely hidden. This makes a multi-question AskUserQuestion
  // feel like a flow rather than a wall of pickers — answer one,
  // advance to the next.
  const [currentIndex, setCurrentIndex] = createSignal(0)

  function pickedFor(questionText: string): ReadonlySet<string> {
    return selections()[questionText] ?? new Set<string>()
  }

  function customTextFor(questionText: string): string {
    return otherText()[questionText] ?? ""
  }

  function setCustomText(questionText: string, value: string): void {
    const sanitized = value.replace(/[\r\n]+/g, "")
    setOtherText((prev) => ({ ...prev, [questionText]: sanitized }))
  }

  // True while the CURRENT question's "Other" sentinel is picked and
  // the row is still pending. Scoped to the current question only —
  // past questions' Other inputs aren't rendered any more so they
  // shouldn't keep claiming composer focus. The createEffect below
  // mirrors this into the parent so the composer can release focus to
  // our inline input — opentui keeps a single focused input at a time
  // and the composer otherwise wins.
  function currentOtherActive(): boolean {
    if (isAnswered()) return false
    const q = r().questions[currentIndex()]
    if (!q) return false
    return pickedFor(q.question).has(OTHER_SENTINEL)
  }
  createEffect(() => {
    props.onClaimComposerFocus?.(currentOtherActive())
  })
  onCleanup(() => {
    // Row unmounting (task switch, scroll-off, etc.) — release any
    // outstanding claim so the composer doesn't stay defocused.
    props.onClaimComposerFocus?.(false)
  })

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

  // Build the final answer string for a single question. Preserves
  // option order (Set iteration is insertion order, but we re-order
  // to match the upstream options list so the model sees a
  // deterministic string). The OTHER_SENTINEL is replaced with the
  // user's typed text — the model never sees the internal label.
  function renderedAnswerFor(q: { question: string; options: readonly { label: string }[] }): string {
    const picked = pickedFor(q.question)
    const ordered: string[] = []
    for (const o of q.options) {
      if (picked.has(o.label)) ordered.push(o.label)
    }
    if (picked.has(OTHER_SENTINEL)) {
      const txt = customTextFor(q.question).trim()
      if (txt) ordered.push(txt)
    }
    return ordered.join(", ")
  }

  // A question is "complete" when there's at least one pick AND, if
  // "Other" is picked, the typed text is non-empty. Sequential mode
  // gates advance / submit on this per-question check.
  function isQuestionComplete(qIdx: number): boolean {
    const q = r().questions[qIdx]
    if (!q) return false
    const picked = pickedFor(q.question)
    if (picked.size === 0) return false
    if (picked.has(OTHER_SENTINEL) && customTextFor(q.question).trim().length === 0) return false
    return true
  }

  const allAnswered = () => {
    for (let i = 0; i < r().questions.length; i++) {
      if (!isQuestionComplete(i)) return false
    }
    return true
  }

  function submit(): void {
    if (!allAnswered() || isAnswered()) return
    const answers: Record<string, string> = {}
    for (const q of r().questions) {
      answers[q.question] = renderedAnswerFor(q)
    }
    props.onAnswer(answers)
  }

  // Per-card action: advance to the next question if the current one
  // is complete, OR fire the final submit if we're on the last
  // question. This is the only place the user "commits" — picking an
  // option just updates local state; commit happens here.
  function advanceOrSubmit(): void {
    if (isAnswered()) return
    const i = currentIndex()
    if (!isQuestionComplete(i)) return
    if (i >= r().questions.length - 1) {
      submit()
    } else {
      setCurrentIndex(i + 1)
    }
  }

  // Keyboard cursor — index into the current question's options list,
  // with `q.options.length` reserved for the auto-added "Other" row at
  // the bottom. Reset to 0 whenever the user advances to a new question
  // so the cursor lands on the first option of the new card.
  const [highlighted, setHighlighted] = createSignal(0)
  createEffect(() => {
    currentIndex()
    setHighlighted(0)
  })

  function toggleByIndex(qIdx: number, optIdx: number): void {
    const q = r().questions[qIdx]
    if (!q) return
    if (optIdx === q.options.length) {
      toggle(q.question, q.multiSelect, OTHER_SENTINEL)
    } else {
      const opt = q.options[optIdx]
      if (opt) toggle(q.question, q.multiSelect, opt.label)
    }
  }

  // Pane-scoped keyboard chords for the picker. Gated on:
  //   - chat pane focused (don't steal j/k from the file tree),
  //   - row not yet submitted,
  //   - the inline "Other" text input not active (when active, the
  //     <input> owns keystrokes and our bindings would double-fire on
  //     every letter typed). The composer itself is hidden during a
  //     question so we don't gate on `questionInlineFocus` from the
  //     parent — currentOtherActive() is the same signal one level up.
  useBindings(() => ({
    enabled: !isAnswered() && !currentOtherActive() && (props.chatFocused?.() ?? true),
    bindings: bindByIds({
      "chat.question.nav": (evt) => {
        const q = r().questions[currentIndex()]
        if (!q) return
        const max = q.options.length
        if (evt.name === "j" || evt.name === "down") {
          setHighlighted((i) => Math.min(i + 1, max))
        } else if (evt.name === "k" || evt.name === "up") {
          setHighlighted((i) => Math.max(i - 1, 0))
        }
      },
      "chat.question.toggle": () => toggleByIndex(currentIndex(), highlighted()),
      "chat.question.submit": () => advanceOrSubmit(),
      "chat.question.pick-number": (evt) => {
        const n = Number.parseInt(evt.name ?? "", 10)
        if (!Number.isFinite(n) || n < 1) return
        const q = r().questions[currentIndex()]
        if (!q) return
        const idx = n - 1
        if (idx > q.options.length) return
        setHighlighted(idx)
        toggleByIndex(currentIndex(), idx)
      },
    }),
  }))

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

      {/* One card per question. Sequential mode: past questions show a
          collapsed "captured answer" preview and are clickable to go
          back; the current question is fully interactive; future
          questions are hidden until the user advances. Post-submit,
          every question shows in `answered` form. */}
      <For each={r().questions}>
        {(q, index) => {
          const finalAnswer = () => r().answers?.[q.question] ?? null
          const picked = () => pickedFor(q.question)
          const isCurrent = () => !isAnswered() && index() === currentIndex()
          const isPast = () => !isAnswered() && index() < currentIndex()
          const isFuture = () => !isAnswered() && index() > currentIndex()
          const isLast = () => index() === r().questions.length - 1
          const buttonLabel = () => (isLast() ? "[ Submit ]" : "[ Next ]")
          return (
            <Show when={!isFuture()}>
              <box
                paddingLeft={2}
                paddingTop={1}
                flexDirection="column"
                gap={0}
                onMouseUp={isPast() ? () => setCurrentIndex(index()) : undefined}
              >
                <box flexDirection="row" gap={1}>
                  <Show when={q.header}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      [{q.header}]
                    </text>
                  </Show>
                  <text fg={isPast() ? theme.textMuted : theme.text}>{q.question}</text>
                  <Show when={q.multiSelect && isCurrent()}>
                    <text fg={theme.textMuted}>(pick any)</text>
                  </Show>
                  <Show when={isPast()}>
                    <text fg={theme.textMuted}>(click to edit)</text>
                  </Show>
                </box>
                {/* Final answered state: render the chosen value(s) as a single line. */}
                <Show when={isAnswered()}>
                  <box paddingLeft={2}>
                    <text fg={theme.success}>
                      {RESULT_PREFIX}
                      {finalAnswer() && finalAnswer()!.length > 0 ? finalAnswer() : "(no answer)"}
                    </text>
                  </box>
                </Show>
                {/* Past state: locked-in answer summary derived from
                    local selections. Visual only — still mutable by
                    clicking the row to jump back. */}
                <Show when={isPast()}>
                  <box paddingLeft={2}>
                    <text fg={theme.textMuted}>
                      {RESULT_PREFIX}
                      {renderedAnswerFor(q).length > 0 ? renderedAnswerFor(q) : "(no answer)"}
                    </text>
                  </box>
                </Show>
                {/* Current state: list options, click to toggle. */}
                <Show when={isCurrent()}>
                  <box paddingLeft={2} flexDirection="column">
                    <For each={q.options}>
                      {(opt, optIndex) => {
                        const isPicked = () => picked().has(opt.label)
                        const isHl = () => highlighted() === optIndex()
                        const glyph = () => (q.multiSelect ? (isPicked() ? "[x]" : "[ ]") : isPicked() ? "(•)" : "( )")
                        // Single-digit shortcut: only options 1-9 get a
                        // visible digit. Past 9 the prefix is two spaces
                        // so the columns still line up under the picker.
                        const digitChip = () => (optIndex() < 9 ? `${optIndex() + 1}.` : "  ")
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            onMouseUp={() => toggle(q.question, q.multiSelect, opt.label)}
                          >
                            <text fg={isHl() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {isHl() ? ">" : " "}
                            </text>
                            <text fg={theme.textMuted}>{digitChip()}</text>
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
                    {/* Auto-appended "Other" — synthesized client-side
                        per the AskUserQuestion tool's "always offer
                        custom text" contract. Same toggle path as real
                        options; picking it reveals the inline text
                        input below. */}
                    {(() => {
                      const otherPicked = () => picked().has(OTHER_SENTINEL)
                      const otherIdx = q.options.length
                      const isOtherHl = () => highlighted() === otherIdx
                      const otherGlyph = () =>
                        q.multiSelect ? (otherPicked() ? "[x]" : "[ ]") : otherPicked() ? "(•)" : "( )"
                      const otherDigitChip = () => (otherIdx < 9 ? `${otherIdx + 1}.` : "  ")
                      return (
                        <>
                          <box
                            flexDirection="row"
                            gap={1}
                            onMouseUp={() => toggle(q.question, q.multiSelect, OTHER_SENTINEL)}
                          >
                            <text fg={isOtherHl() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {isOtherHl() ? ">" : " "}
                            </text>
                            <text fg={theme.textMuted}>{otherDigitChip()}</text>
                            <text fg={otherPicked() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {otherGlyph()}
                            </text>
                            <box flexGrow={1} flexDirection="column">
                              <text fg={theme.text}>Other</text>
                              <text fg={theme.textMuted}>Type your own answer</text>
                            </box>
                          </box>
                          <Show when={otherPicked()}>
                            <box paddingLeft={4} paddingTop={0}>
                              <input
                                value={customTextFor(q.question)}
                                placeholder="type your answer…"
                                focused={true}
                                onInput={(v: string) => setCustomText(q.question, v)}
                                onSubmit={() => advanceOrSubmit()}
                              />
                            </box>
                          </Show>
                        </>
                      )
                    })()}
                    {/* Per-card Next / Submit. The last question's
                        button reads "Submit" so the existing behavior
                        tests still find the substring. Earlier
                        questions read "Next" — advances currentIndex
                        without sending anything to the engine. */}
                    <box paddingLeft={0} paddingTop={1} flexDirection="row" gap={2}>
                      <text
                        fg={isQuestionComplete(index()) ? theme.success : theme.textMuted}
                        attributes={TextAttributes.BOLD}
                        onMouseUp={() => advanceOrSubmit()}
                      >
                        {buttonLabel()}
                      </text>
                      <Show when={!isQuestionComplete(index())}>
                        <text fg={theme.textMuted}>(pick an option to continue)</text>
                      </Show>
                    </box>
                  </box>
                </Show>
              </box>
            </Show>
          )
        }}
      </For>

      {/* Final-state chip — only rendered post-submit. Drives the
          existing behavior-test assertion on "[submitted]". */}
      <Show when={isAnswered()}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.success} attributes={TextAttributes.BOLD}>
            [submitted]
          </text>
        </box>
      </Show>
    </box>
  )
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
  return (
    <box flexDirection="column" gap={0}>
      {/* Empty placeholder — same copy as before so behavior tests
          asserting on substring "Type a prompt below" still pass. */}
      <Show when={props.messages.length === 0 && props.showEmptyPlaceholder}>
        <box paddingTop={2}>
          <text fg={theme.textMuted}>Type a prompt below.</text>
        </box>
      </Show>

      <For each={groupRenderItems(props.messages, props.expandedFoldStartIndex)}>
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
          if (row.kind === "system") return <SystemRow text={row.text} />
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
              onToggle={() => props.onToggleTool(i)}
            />
          )
        }}
      </For>

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
 * Compress consecutive runs of tool rows into one summary line (Claude
 * Code's "Searched for X patterns, read Y files, ran Z bash commands"
 * pattern — see `refs/claude-code/src/utils/collapseReadSearch.ts`
 * `getSearchReadSummaryText`).
 *
 * We fold proactively — including runs with in-flight tools — so the
 * transition from "individual rows" to "fold summary" doesn't visually
 * pop the moment the last tool in the run finishes. Present-tense
 * summary ("Reading 3 files…") while any tool is in flight, past tense
 * once they all settle.
 *
 * Threshold: 3+ consecutive tools. Click the fold row to expand and see
 * the individual tool rows underneath.
 */
type ToolCounts = { search: number; read: number; list: number; bash: number; other: number }

type RenderItem =
  | { kind: "row"; row: ChatRow; index: number }
  | { kind: "fold"; counts: ToolCounts; startIndex: number; inFlight: number }

const TOOL_FOLD_THRESHOLD = 3

export function groupRenderItems(
  messages: readonly ChatRow[],
  expandedFoldStartIndex: number | null = null,
): RenderItem[] {
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
    if (j - i >= TOOL_FOLD_THRESHOLD) {
      const counts: ToolCounts = { search: 0, read: 0, list: 0, bash: 0, other: 0 }
      let inFlight = 0
      for (let k = i; k < j; k++) {
        const r = messages[k]
        if (r?.kind !== "tool") continue
        counts[classifyTool(r.name)]++
        if (!r.done) inFlight++
      }
      items.push({ kind: "fold", counts, startIndex: i, inFlight })
      if (expandedFoldStartIndex === i) {
        for (let k = i; k < j; k++) {
          const r = messages[k]
          if (r) items.push({ kind: "row", row: r, index: k })
        }
      }
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
 * mirrors Claude Code's `getSearchReadSummaryText`. When `inFlight` is
 * true, switch to present continuous ("Searching… / Reading… / Listing…
 * / Running…") so the fold summary can render before all tools settle
 * without the wording lying about what's already done.
 */
export function summarizeToolRun(c: ToolCounts, inFlight = false): string {
  const verbs = inFlight
    ? {
        search: ["Searching", "searching"],
        read: ["Reading", "reading"],
        list: ["Listing", "listing"],
        bash: ["Running", "running"],
        other: ["Using", "using"],
      }
    : {
        search: ["Searched", "searched"],
        read: ["Read", "read"],
        list: ["Listed", "listed"],
        bash: ["Ran", "ran"],
        other: ["Used", "used"],
      }
  const parts: string[] = []
  if (c.search > 0) {
    const [vUp, vLo] = verbs.search
    const verb = parts.length === 0 ? vUp : vLo
    const tail = inFlight
      ? `${c.search} ${c.search === 1 ? "pattern" : "patterns"}`
      : `for ${c.search} ${c.search === 1 ? "pattern" : "patterns"}`
    parts.push(`${verb} ${tail}`)
  }
  if (c.read > 0) {
    const [vUp, vLo] = verbs.read
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.read} ${c.read === 1 ? "file" : "files"}`)
  }
  if (c.list > 0) {
    const [vUp, vLo] = verbs.list
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.list} ${c.list === 1 ? "directory" : "directories"}`)
  }
  if (c.bash > 0) {
    const [vUp, vLo] = verbs.bash
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.bash} bash ${c.bash === 1 ? "command" : "commands"}`)
  }
  if (c.other > 0) {
    const [vUp, vLo] = verbs.other
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.other} ${c.other === 1 ? "other tool" : "other tools"}`)
  }
  return parts.join(", ")
}

/**
 * One-line render for a folded run. Click toggles expansion — when
 * expanded, the individual tool rows render directly under this fold
 * (groupRenderItems emits both). Glyph swaps `▶`/`▼` for collapsed/
 * expanded; in-flight runs use `✻` (matches ToolRow's running prefix)
 * so the user sees the run is still streaming.
 */
function ToolFoldRow(props: { summary: string; expanded: boolean; inFlight: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const glyph = () => (props.inFlight ? "✻" : props.expanded ? "▼" : "▶")
  const fg = () => (props.inFlight ? theme.warning : theme.textMuted)
  return (
    <box paddingTop={1} flexDirection="row" gap={1} onMouseUp={() => props.onToggle()}>
      <text fg={fg()} attributes={TextAttributes.DIM}>
        {glyph()}
      </text>
      <box flexGrow={1}>
        <text fg={theme.textMuted}>{props.summary}</text>
      </box>
    </box>
  )
}
