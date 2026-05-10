/**
 * Wave 4.B follow-up — inline Bash renderer helpers.
 *
 * Pattern lifted from upstream Claude Code:
 *   - `refs/claude-code/src/components/messages/BashToolUseMessage.tsx`
 *     — banner shape `$ <command>` (a leading `$` chip in accent),
 *     optional `# description` annotation, and a stdout/stderr block
 *     under the banner. Long output is truncated to a small head of
 *     lines with a `… N more lines` tail so the chat stays skimmable.
 *
 * The chat surface in kobe doesn't have access to the live shell exit
 * code or stderr separately — the orchestrator hands us a single
 * `output` string per tool result. The store's `output` field is
 * usually a string but can be `unknown`, so {@link readBashInput} and
 * {@link splitBashOutput} both normalise to strings before splitting.
 *
 * This module is a pure helper so it can be unit-tested without
 * mounting opentui. The caller (`MessageList.tsx`) renders the
 * returned shape as Solid `<text>` rows.
 */

/** Lines in the collapsed output preview; matches edit-diff.ts cap so the
 *  chat's tool-row chrome feels uniform. Picked to keep a single bash
 *  call from dominating the chat scroll while still showing the
 *  "shape" of the output. */
export const BASH_OUTPUT_COLLAPSED_CAP = 10

/** Parsed view of a Bash tool input. */
export interface BashInputView {
  /** The shell command. Empty string if the input is malformed. */
  readonly command: string
  /** Optional `description` field — Claude Code emits this when the
   *  model annotates *why* it's running the command. Empty string if
   *  the model omitted it (the most common case). */
  readonly description: string
}

/** Parsed view of a Bash tool output (truncated for the collapsed render). */
export interface BashOutputView {
  /** Total line count of the output before truncation. */
  readonly totalLines: number
  /** Visible lines after applying {@link BASH_OUTPUT_COLLAPSED_CAP}. */
  readonly visible: readonly string[]
  /** Number of lines hidden by the cap (0 if the output fit). */
  readonly hidden: number
}

/**
 * Read a Bash tool's `input` blob into `{command, description}`. Falls
 * back to empty strings for any missing/wrong-shape field so the
 * renderer can paint a deterministic banner for any input.
 */
export function readBashInput(input: unknown): BashInputView {
  if (input == null || typeof input !== "object") {
    return { command: "", description: "" }
  }
  const o = input as Record<string, unknown>
  return {
    command: typeof o.command === "string" ? o.command : "",
    description: typeof o.description === "string" ? o.description : "",
  }
}

/**
 * Split a Bash output payload into a capped, line-by-line view. Accepts
 * `unknown` because the engine event stream's `output` field is loosely
 * typed. Non-string payloads are JSON-stringified so the user still
 * sees something rather than a blank row.
 *
 * `cap < 0` means "no truncation" — used by the expanded view.
 */
export function splitBashOutput(output: unknown, cap: number = BASH_OUTPUT_COLLAPSED_CAP): BashOutputView {
  const text = normaliseOutput(output)
  if (text.length === 0) return { totalLines: 0, visible: [], hidden: 0 }
  // Trim a single trailing newline so a command that ends with `\n`
  // doesn't add a phantom blank line at the bottom of the preview.
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text
  const lines = trimmed.split(/\r?\n/)
  if (cap < 0 || lines.length <= cap) {
    return { totalLines: lines.length, visible: lines, hidden: 0 }
  }
  return { totalLines: lines.length, visible: lines.slice(0, cap), hidden: lines.length - cap }
}

function normaliseOutput(output: unknown): string {
  if (output == null) return ""
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}
