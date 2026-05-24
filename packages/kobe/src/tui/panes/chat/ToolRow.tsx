import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import {
  BASH_OUTPUT_COLLAPSED_CAP,
  type BashInputView,
  type BashOutputView,
  readBashInput,
  splitBashOutput,
} from "./bash-render"
import {
  COLLAPSED_LINE_CAP,
  type FormattedDiff,
  type FormattedMultiEditDiff,
  capLines,
  formatEditDiff,
  formatMultiEditDiff,
  formatWriteDiff,
} from "./edit-diff"
import { BLACK_CIRCLE, RESULT_PREFIX } from "./message-figures"
import type { ChatRow, ToolChildRow } from "./store"
import {
  type SnapshotItem,
  TODO_GLYPH,
  type TaskStatus,
  countTodos,
  parseTaskCreateInput,
  parseTaskUpdateInput,
  parseTaskUpdateOutput,
  summarizeTodos,
} from "./todo-render"
import { summarizeGlob, summarizeGrep, summarizeRead } from "./tool-banners"
import { type ToolCounts, summarizeToolRun } from "./tool-fold"
import { classifyTool, lookupToolMeta } from "./tool-registry"

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
export function ToolRow(props: {
  row: Extract<ChatRow, { kind: "tool" }>
  index: number
  expanded: boolean
  /**
   * "Rounded" snapshot items for this row — only the tasks that belong
   * to *this round* (older rounds' completed tasks filtered out by the
   * cross-row pass in {@link computeRoundedSnapshots}). `undefined` for
   * non-snapshot tool rows and for rows the pass didn't visit yet.
   */
  roundedItems?: readonly SnapshotItem[]
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const r = () => props.row
  // Snapshot rows (TodoWrite/TaskList) get a green expand triangle as
  // their prefix glyph instead of the usual ● / ✻ status dot — the
  // row's body is collapsible, and the triangle is the standard "click
  // to expand / collapse" affordance.
  const prefixGlyph = () => {
    if (isTodoSnapshot()) return props.expanded ? "▼" : "▶"
    return r().done ? BLACK_CIRCLE : "✻"
  }
  const prefixColor = () => {
    if (isTodoSnapshot()) return theme.success
    return r().done ? theme.success : theme.warning
  }
  // Render strategy comes from the per-vendor tool registry. The
  // string-literal name comparisons that used to live here moved to
  // `tool-registry.ts` so that adding a Codex tool only edits one place.
  const meta = () => lookupToolMeta(r().name)
  const isDiffTool = () => meta().body === "edit-diff"
  const isMultiEdit = () => meta().body === "multi-edit-diff"
  const isBash = () => meta().banner === "bash"
  const isReadGrepGlob = () => meta().banner === "read-grep-glob"
  const isSubagent = () => meta().body === "subagent"
  const isTodoSnapshot = () => meta().body === "todo-snapshot"
  const isTaskAction = () => meta().banner === "task-action"
  /** Tools whose banner replaces the generic `tool(arg-preview)` chip. */
  const usesCustomBanner = () => meta().banner !== "default" || meta().body !== "default"
  /** Tools whose body renders inline so the generic preview/expanded
   *  blocks below should be suppressed. */
  const usesCustomBody = () =>
    meta().body === "edit-diff" ||
    meta().body === "multi-edit-diff" ||
    meta().body === "bash-output" ||
    meta().body === "subagent" ||
    meta().body === "todo-snapshot"
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
            when={isSubagent()}
            fallback={
              <Show
                when={isTodoSnapshot()}
                fallback={
                  <Show
                    when={isTaskAction()}
                    fallback={
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
                    }
                  >
                    <TaskActionBanner row={r()} />
                  </Show>
                }
              >
                <TodoSnapshotBanner items={props.roundedItems ?? []} name={r().name} />
              </Show>
            }
          >
            <SubagentBanner row={r()} />
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
      {/* Subagent (Agent/Task) — nested tool-step progress. Collapsed:
          a one-line "Searching 2 patterns, reading 3 files…" summary.
          Expanded: the per-step list. */}
      <Show when={isSubagent()}>
        <SubagentBody row={r()} expanded={props.expanded} onToggle={props.onToggle} />
      </Show>
      {/* Task-snapshot tools (TodoWrite v1 / TaskList v2) — checklist
          body. Always collapsed by default (panel above the composer is
          the canonical "current plan" surface); click the banner to
          expand and see the historical round snapshot. */}
      <Show when={isTodoSnapshot()}>
        <TodoSnapshotBody items={props.roundedItems ?? []} expanded={props.expanded} onToggle={props.onToggle} />
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
 * Pull the human-readable description out of an Agent/Task tool input.
 * Claude's Task tool takes `{ description, prompt, subagent_type }`;
 * `description` is the short label the parent agent gave the subagent.
 */
function subagentDescription(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const d = (input as Record<string, unknown>).description
    if (typeof d === "string" && d.trim().length > 0) return d.trim()
  }
  return ""
}

/**
 * Banner for an Agent/Task (subagent) tool row — bold tool name plus
 * the dim `(description)` the parent gave the subagent. Mirrors the
 * `ReadGrepGlobBanner` shape so all the "named activity" rows read the
 * same.
 */
function SubagentBanner(props: { row: Extract<ChatRow, { kind: "tool" }> }) {
  const { theme } = useTheme()
  const desc = () => subagentDescription(props.row.input)
  return (
    <text fg={theme.text} wrapMode="none">
      <span style={{ attributes: TextAttributes.BOLD }}>{props.row.name}</span>
      <Show when={desc().length > 0}>
        <span style={{ fg: theme.textMuted }}>{` (${desc()})`}</span>
      </Show>
    </text>
  )
}

/**
 * Body for an Agent/Task (subagent) tool row — shows the subagent's
 * nested tool steps (collected on `row.children` from `parentId`-tagged
 * engine events). This is the "watch the subagent work" surface: kobe
 * deliberately does NOT flatten the subagent's Read/Grep/Bash calls
 * into the parent transcript (that's noise), so this nested block is
 * the only place they appear.
 *
 *   - Collapsed: one dim progress line — `Searching 2 patterns, reading
 *     3 files` while in flight, `Searched …, read …` once the subagent
 *     finishes. Reuses `summarizeToolRun`, the same summary the
 *     top-level tool-fold uses, so the vocabulary is consistent.
 *   - Expanded: the per-step list, each step a `● name(args)` line with
 *     a running/done glyph.
 */
function SubagentBody(props: {
  row: Extract<ChatRow, { kind: "tool" }>
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const children = (): readonly ToolChildRow[] => props.row.children ?? []
  const counts = (): ToolCounts => {
    const c: ToolCounts = { search: 0, read: 0, list: 0, bash: 0, other: 0 }
    for (const ch of children()) c[classifyTool(ch.name)]++
    return c
  }
  const anyInFlight = () => children().some((ch) => !ch.done)
  const summary = (): string => {
    if (children().length === 0) return props.row.done ? "No tool steps" : "Starting…"
    return summarizeToolRun(counts(), anyInFlight())
  }
  return (
    <box paddingLeft={2} flexDirection="column" onMouseUp={() => props.onToggle()}>
      <Show when={!props.expanded}>
        <text fg={theme.textMuted} wrapMode="none">
          {RESULT_PREFIX}
          {summary()}
        </text>
      </Show>
      <Show when={props.expanded}>
        <Show
          when={children().length > 0}
          fallback={
            <text fg={theme.textMuted} wrapMode="none">
              {RESULT_PREFIX}
              {summary()}
            </text>
          }
        >
          <For each={children()}>
            {(ch) => (
              <box flexDirection="row" gap={1}>
                <text fg={ch.done ? theme.success : theme.warning} attributes={TextAttributes.BOLD}>
                  {ch.done ? BLACK_CIRCLE : "✻"}
                </text>
                <box flexGrow={1}>
                  <text fg={theme.text} wrapMode="none">
                    <span style={{ attributes: TextAttributes.BOLD }}>{ch.name}</span>
                    <span style={{ fg: theme.textMuted }}>{`(${previewToolInput(ch.input)})`}</span>
                  </text>
                </box>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

/**
 * Banner for a task-snapshot row (TodoWrite v1 / TaskList v2) — bold
 * tool name + dim status-count chip (`6 todos · ✓3 ◼1 ◻2`). The
 * row-level prefix glyph (`▶`/`▼`, green) carries the expand
 * affordance, so no inline chip is needed here. Reflects the
 * **rounded** slice (this round only — see
 * {@link computeRoundedSnapshots}) so the count matches the body's
 * checklist when the user expands it.
 */
function TodoSnapshotBanner(props: { items: readonly SnapshotItem[]; name: string }) {
  const { theme } = useTheme()
  const summary = () => summarizeTodos(countTodos(props.items))
  return (
    <text fg={theme.text} wrapMode="none">
      <span style={{ attributes: TextAttributes.BOLD }}>{props.name}</span>
      <span style={{ fg: theme.textMuted }}>{` · ${summary()}`}</span>
    </text>
  )
}

/**
 * Body for a task-snapshot row — the inline checklist. Default state
 * is **collapsed** (banner only); the always-on `TodoStatusLine` above
 * the composer is the canonical "current plan" surface, so listing the
 * same tasks again inline right under the banner is pure redundancy.
 * Click the banner to expand and see this round's snapshot (older
 * rounds' completed items are already filtered out by the cross-row
 * pass in {@link computeRoundedSnapshots}).
 */
function TodoSnapshotBody(props: { items: readonly SnapshotItem[]; expanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const items = (): readonly SnapshotItem[] => props.items
  const show = () => props.expanded
  const colorFor = (status: TaskStatus) =>
    status === "completed"
      ? theme.success
      : status === "in_progress"
        ? theme.accent
        : status === "deleted"
          ? theme.error
          : theme.textMuted
  // Matches Claude Code's TaskListV2 attribute combo:
  //   completed → dim + strikethrough; in_progress → bold; pending → plain.
  const subjectAttrs = (status: TaskStatus) => {
    if (status === "completed" || status === "deleted") return TextAttributes.DIM | TextAttributes.STRIKETHROUGH
    if (status === "in_progress") return TextAttributes.BOLD
    return TextAttributes.NONE
  }
  return (
    <Show when={show() && items().length > 0}>
      <box paddingLeft={2} flexDirection="column" onMouseUp={() => props.onToggle()}>
        <For each={items()}>
          {(t) => (
            <box flexDirection="row" gap={1}>
              <text fg={colorFor(t.status)} wrapMode="none">
                {TODO_GLYPH[t.status]}
              </text>
              <box flexGrow={1}>
                <text fg={t.status === "pending" ? theme.text : colorFor(t.status)} attributes={subjectAttrs(t.status)}>
                  {t.displayText}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/**
 * Banner for v2 task-action tools (`TaskCreate / TaskUpdate / TaskGet`).
 * These are single-item operations against an internal task store, so
 * the banner does the work — body falls back to the default collapsed
 * preview / expanded-JSON renderer.
 *
 *   - `TaskCreate · "<subject>"` — taken from input.subject.
 *   - `TaskUpdate · #<id> · <fromStatus → toStatus>` (status change),
 *     `· updated: <fields>` (other fields), or `· deleted` (deleted
 *     status). Falls back to `#<id>` if neither input nor output gives
 *     enough information.
 *   - `TaskGet · #<id>` — bare id chip.
 */
function TaskActionBanner(props: { row: Extract<ChatRow, { kind: "tool" }> }) {
  const { theme } = useTheme()
  const summary = (): string => {
    const row = props.row
    if (row.name === "TaskCreate") {
      const input = parseTaskCreateInput(row.input)
      return input ? `"${input.subject}"` : ""
    }
    if (row.name === "TaskUpdate") {
      const input = parseTaskUpdateInput(row.input)
      const output = parseTaskUpdateOutput(row.output)
      const id = input?.taskId ?? output?.taskId ?? ""
      const idChip = id ? `#${id}` : ""
      if (output?.error) return `${idChip} · ${output.error}`
      if (output?.statusChange) return `${idChip} · ${output.statusChange.from} → ${output.statusChange.to}`
      if (input?.status === "deleted") return `${idChip} · deleted`
      if (input?.status) return `${idChip} · → ${input.status}`
      if (output?.updatedFields.length) return `${idChip} · updated: ${output.updatedFields.join(", ")}`
      return idChip
    }
    if (row.name === "TaskGet") {
      const input = row.input as { taskId?: unknown } | null
      const id = input && typeof input === "object" && typeof input.taskId === "string" ? input.taskId : ""
      return id ? `#${id}` : ""
    }
    return ""
  }
  return (
    <text fg={theme.text} wrapMode="none">
      <span style={{ attributes: TextAttributes.BOLD }}>{props.row.name}</span>
      <Show when={summary().length > 0}>
        <span style={{ fg: theme.textMuted }}>{` · ${summary()}`}</span>
      </Show>
    </text>
  )
}
