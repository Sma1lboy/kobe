/**
 * Wave 4.B follow-up — pure banner formatters for the simpler
 * "search/inspect" tools (Read / Grep / Glob).
 *
 * Pattern lifted from upstream Claude Code's per-tool messages:
 *   - `refs/claude-code/src/components/messages/ReadToolUseMessage.tsx`
 *   - `refs/claude-code/src/components/messages/GrepToolUseMessage.tsx`
 *   - `refs/claude-code/src/components/messages/GlobToolUseMessage.tsx`
 *
 * Each returns a one-line summary string the chat's `ToolRow` renders
 * to the right of the bold tool name. They live in their own module
 * (rather than inline in `MessageList.tsx`) so they can be unit-tested
 * without pulling in the opentui/Solid renderer chain.
 */

function readStringField(input: unknown, key: string): string {
  if (input == null || typeof input !== "object") return ""
  const v = (input as Record<string, unknown>)[key]
  return typeof v === "string" ? v : ""
}

function readNumberField(input: unknown, key: string): number | null {
  if (input == null || typeof input !== "object") return null
  const v = (input as Record<string, unknown>)[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * Read banner: `<file> · L<start>-<end>` when an explicit
 * `{offset, limit}` range is present, `<file>` alone otherwise. Mirrors
 * upstream's "Read /abs/path" banner with the optional range chip.
 */
export function summarizeRead(input: unknown): string {
  const file_path = readStringField(input, "file_path") || "(unknown file)"
  const offset = readNumberField(input, "offset")
  const limit = readNumberField(input, "limit")
  if (offset !== null && limit !== null) {
    return `${file_path} · L${offset}-${offset + limit}`
  }
  if (offset !== null) {
    return `${file_path} · L${offset}-`
  }
  if (limit !== null) {
    return `${file_path} · L1-${limit}`
  }
  return file_path
}

/**
 * Try to extract a "<N matches>" hint from a Grep tool's output. The
 * result string upstream Grep emits is one of:
 *   - "Found N file(s)" / "Found N match(es)" — output_mode=files_with_matches/count
 *   - A `path:N` block — output_mode=count
 *   - A list of `path:line:content` rows — output_mode=content (default)
 *
 * We attempt the first two patterns explicitly; the third we count by
 * non-empty line count (≥ 1). Falls back to `(searching…)` while the
 * tool is still in flight (its result hasn't arrived yet).
 */
export function summarizeGrep(input: unknown, output: unknown, done: boolean): string {
  const pattern = readStringField(input, "pattern")
  const head = pattern ? `"${pattern}"` : "(no pattern)"
  if (!done) return `${head} · (searching…)`
  if (typeof output !== "string" || output.length === 0) return `${head} · 0 matches`
  const found = output.match(/^Found (\d+)\s+(file|match|line)/i)
  if (found) {
    const n = Number(found[1])
    const noun = found[2]?.toLowerCase() === "file" ? (n === 1 ? "file" : "files") : n === 1 ? "match" : "matches"
    return `${head} · ${n} ${noun}`
  }
  const lines = output.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return `${head} · 0 matches`
  return `${head} · ${lines.length} ${lines.length === 1 ? "match" : "matches"}`
}

/**
 * Glob banner: `"<pattern>" · <N files>` (or `(searching…)` while
 * in-flight). Glob upstream returns one path per line; we count
 * non-empty lines. The "No files found" / "No matches found" preamble
 * upstream emits is normalised to `0 files`.
 */
export function summarizeGlob(input: unknown, output: unknown, done: boolean): string {
  const pattern = readStringField(input, "pattern")
  const head = pattern ? `"${pattern}"` : "(no pattern)"
  if (!done) return `${head} · (searching…)`
  if (typeof output !== "string" || output.length === 0) return `${head} · 0 files`
  if (/^no (files|matches) found/i.test(output)) return `${head} · 0 files`
  const lines = output.split(/\r?\n/).filter((l) => l.length > 0)
  return `${head} · ${lines.length} ${lines.length === 1 ? "file" : "files"}`
}
