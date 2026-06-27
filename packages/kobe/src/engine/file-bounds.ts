/**
 * Defensive bounds for reading vendor-owned transcript / credential files.
 *
 * The engine readers (`claude-code-local`, `codex-local`, `copilot-local`
 * history; `account-detect`) load whole on-disk JSONL transcripts and JSON
 * credential files that kobe does not control. A corrupt or pathological file
 * — a multi-GB rollout, a single mega-line — could OOM or hang the TUI/daemon
 * if read and `JSON.parse`d unbounded. These helpers add cheap, best-effort
 * ceilings: stat the file before slurping it, and skip a line that's too long
 * to be real before handing it to `JSON.parse`.
 *
 * Everything here is best-effort and non-throwing into the degraded path:
 * oversize → an empty result (the same shape callers already produce for a
 * missing/empty file), never a crash, never a leak of file contents.
 */

import { readFileSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"

/**
 * Hard ceiling (bytes) on a single transcript/credential file we'll read into
 * a string. 100 MiB is far above any real Claude/Codex/Copilot transcript or
 * `~/.claude.json` (typically KB–single-digit MB) yet small enough that the
 * read + `JSON.parse` can't exhaust memory. Above this we degrade rather than
 * load — a file this large is corrupt or adversarial, not a real session.
 */
export const MAX_ENGINE_FILE_BYTES = 100 * 1024 * 1024

/**
 * Hard ceiling (chars) on a single JSONL line we'll attempt to `JSON.parse`.
 * Real records are at most a few hundred KB; a line past 8 MiB is pathological
 * (a mega-blob smuggled into one record) and parsing it can hang. Such a line
 * is skipped exactly like a malformed one — the reader continues.
 */
export const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024

/**
 * Read a text file but bail to `""` when it exceeds {@link MAX_ENGINE_FILE_BYTES}.
 * `stat` first so a giant file is never slurped into a string. ENOENT and other
 * I/O errors propagate (callers already `catch` them to degrade); only the
 * oversize case is folded into the empty-result path.
 */
export async function readTextFileBounded(p: string, maxBytes = MAX_ENGINE_FILE_BYTES): Promise<string> {
  const { size } = await stat(p)
  if (size > maxBytes) return ""
  return readFile(p, "utf8")
}

/**
 * Synchronous twin of {@link readTextFileBounded} for `account-detect`'s
 * credential reads. Returns `null` for a missing OR oversize file so the caller
 * produces its existing "not detected" result; other I/O errors propagate.
 * Never logs file contents.
 */
export function readTextFileSyncBounded(p: string, maxBytes = MAX_ENGINE_FILE_BYTES): string | null {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  if (st.size > maxBytes) return null
  return readFileSync(p, "utf8")
}

/**
 * True when a JSONL line is short enough to be worth `JSON.parse`-ing. A line
 * past {@link MAX_JSONL_LINE_CHARS} is treated as unparseable (skipped) so a
 * single mega-line can't hang the parser.
 */
export function isJsonlLineWithinBound(line: string, maxChars = MAX_JSONL_LINE_CHARS): boolean {
  return line.length <= maxChars
}
