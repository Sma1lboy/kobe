/**
 * Boil a `readFile` / `readDiff` error string down to something the
 * user can act on. The wrappers emit shapes like
 *   `cat: foo.bin: No such file or directory`
 *   `git diff <base> ... exited 128: fatal: ambiguous argument 'main'`
 * Stripping the binary name + leading prefix keeps the line short
 * enough to show without wrapping in narrow preview panes.
 *
 * Pure module — extracted from Preview.tsx so any sub-body that
 * surfaces an error can import the same summarizer.
 */

export function summarizePreviewError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes("no such file") || m.includes("enoent")) return "file not found (rebased away?)"
  if (m.includes("permission denied") || m.includes("eacces")) return "permission denied"
  if (m.includes("ambiguous argument") || m.includes("unknown revision"))
    return "diff base does not resolve in this worktree"
  if (m.includes("path escapes worktree")) return "refused: path escapes worktree"
  if (m.includes("no worktree")) return "no active worktree"
  // Fallback: strip a `prog: path: ` prefix if present.
  const trimmed = raw.replace(/^([a-z0-9_-]+:\s+){1,2}/i, "").trim()
  return trimmed || "could not read file"
}

/**
 * Cheap binary sniff: any NUL byte in the first 8 KiB. Matches what
 * `git diff` uses internally and is good enough for the TUI — text
 * files are virtually never NUL-bearing, image/zip/wasm payloads
 * always are.
 */
export function looksBinary(text: string): boolean {
  const probe = text.length > 8192 ? text.slice(0, 8192) : text
  return probe.indexOf("\u0000") >= 0
}
