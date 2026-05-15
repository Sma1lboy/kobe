import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Markdown } from "./Markdown"
import type { BashOutputView } from "./bash-render"
import { splitBashOutput } from "./bash-render"
import { prettifyPastedImageRefs } from "./composer/image-paste"
import {
  COMMAND_ARGS_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  extractTag,
} from "./composer/xml-tags"
import { BLACK_CIRCLE, REFERENCE_MARK } from "./message-figures"
import type { ChatRow } from "./row-types"

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
export function UserRow(props: { text: string }) {
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
export function AssistantRow(props: { text: string }) {
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

export function ReasoningRow(props: { text: string }) {
  const { theme } = useTheme()
  return (
    <box paddingTop={1} flexDirection="row" gap={1}>
      <box width={2} flexShrink={0}>
        <text fg={theme.success} attributes={TextAttributes.BOLD}>
          {BLACK_CIRCLE}
        </text>
      </box>
      <box flexGrow={1} flexDirection="column">
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          思考过程
        </text>
        <Markdown source={props.text} />
      </box>
    </box>
  )
}

/**
 * `!shell` (bash mode) row — user-initiated shell command, rendered as
 * `! <command>` banner + indented stdout/stderr block + completion chip
 * (exit code or "interrupted"). Distinct from the model-initiated
 * `BashBanner` / `BashOutputBlock` pair (which use a `$` chip in
 * theme.accent) so the user can tell at a glance which side ran the
 * command. Color mirrors Claude Code's `bashBorder` semantic via
 * theme.warning since kobe doesn't have a dedicated bash color.
 *
 * Streaming: stdout/stderr live as separate strings on the row and are
 * concatenated as the child process emits chunks. `splitBashOutput`
 * caps the collapsed view at {@link BASH_OUTPUT_COLLAPSED_CAP} lines
 * each so a `find /` doesn't dominate the scroll. The `done: false`
 * variant shows a "running…" hint instead of the exit chip.
 */
export function BashRow(props: { row: Extract<ChatRow, { kind: "bash" }> }) {
  const { theme } = useTheme()
  const r = () => props.row
  // No line-count truncation. claude-code's `OutputLine` renders every
  // line of bash output (only per-line column truncation, never a
  // "show first N lines" cap). We mirror that — `splitBashOutput(_, -1)`
  // means "no cap" and yields `hidden: 0`, so the trailing "… N more
  // lines" tail never renders.
  const stdoutView = (): BashOutputView => splitBashOutput(r().stdout, -1)
  const stderrView = (): BashOutputView => splitBashOutput(r().stderr, -1)
  // Successful exits suppress the status footer entirely — the
  // command + its output is enough signal that it ran. We still
  // surface non-success states (running, interrupted, non-zero exit,
  // missing exit code) where the user benefits from knowing.
  const statusText = (): string | null => {
    if (!r().done) return "running…"
    if (r().signal !== null) return `interrupted (${r().signal})`
    const code = r().exitCode
    if (code === null) return "(no exit code)"
    if (code === 0) return null
    return `exit ${code}`
  }
  const statusColor = () => {
    if (!r().done) return theme.textMuted
    if (r().signal !== null) return theme.error
    return theme.error
  }
  return (
    <box paddingTop={1} flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
          !
        </text>
        <box flexGrow={1}>
          <text fg={theme.text} wrapMode="none">
            {r().command || "(empty command)"}
          </text>
        </box>
      </box>
      <Show when={stdoutView().totalLines > 0}>
        <box paddingLeft={2} flexDirection="column">
          <For each={stdoutView().visible}>
            {(line) => (
              <text fg={theme.textMuted} wrapMode="none">
                {line || " "}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={stderrView().totalLines > 0}>
        <box paddingLeft={2} flexDirection="column">
          <For each={stderrView().visible}>
            {(line) => (
              <text fg={theme.error} wrapMode="none">
                {line || " "}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={statusText() != null}>
        <box paddingLeft={2}>
          <text fg={statusColor()} attributes={TextAttributes.DIM}>
            {statusText()}
          </text>
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
export function SystemRow(props: { text: string }) {
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
