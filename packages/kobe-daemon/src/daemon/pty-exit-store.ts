/**
 * Durable death records for hosted PTY sessions.
 *
 * The host keeps an exited session's ring in memory, but the host itself
 * idle-exits ~60s after its last live session dies — exactly the window in
 * which a crashed engine's cause evaporates (issue #9). This store writes a
 * small JSON file per KOBE home (`pty-exits.json`) at exit time so
 * `get-task`/`inspect` can answer "how did it die" long after the host is
 * gone.
 *
 * Noise rules: clean exits (code 0, no signal) and internal keys (the warm
 * `::spare`) are never recorded. The file is capped to the newest
 * {@link MAX_RECORDS} records; a corrupt/missing file reads as empty.
 * Everything here is best-effort by contract — the host wraps the write in
 * its own fail-safe guard too.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { defaultPtyExitsPath } from "./paths.ts"
import type { PtySessionEndInfo } from "./pty-observability.ts"

/** One persisted record, keyed by session key (`taskId::tabId`). */
export interface PtyExitRecord {
  readonly key: string
  readonly pid: number | null
  readonly code: number | null
  readonly signal: string | null
  readonly at: string
  /** Plain-text last lines of output (ANSI stripped, CR-folded). */
  readonly tail: readonly string[]
}

const MAX_RECORDS = 50
const TAIL_LINES = 40
const TAIL_LINE_CHARS = 500

// Same escape grammar the read-output verb strips (CSI / OSC / single-char).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping raw ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g

/** Raw PTY tail → readable last lines: strip ANSI, honor CR overwrites,
 *  drop trailing blanks, keep the last {@link TAIL_LINES}. */
export function plainTail(raw: string): string[] {
  const plain = raw.replace(ANSI_RE, "").replace(/\r\n/g, "\n")
  const lines = plain.split("\n").map((line) => (line.split("\r").pop() ?? "").slice(0, TAIL_LINE_CHARS))
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop()
  return lines.slice(-TAIL_LINES)
}

/** All records keyed by session key; empty on missing/corrupt file. */
export function readPtyExitRecords(path = defaultPtyExitsPath()): Record<string, PtyExitRecord> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, PtyExitRecord>
  } catch {
    return {}
  }
}

/**
 * Persist one session's death record. Clean exits and internal keys are
 * skipped (noise rule); the newest record per key wins; the file keeps only
 * the {@link MAX_RECORDS} newest by exit time. Throws only past the caller's
 * guard — all I/O errors surface to it.
 */
export function recordPtyExit(info: PtySessionEndInfo, path = defaultPtyExitsPath()): void {
  if (info.key.startsWith("::")) return
  if (info.exit.code === 0 && info.exit.signal === null) return
  const records = readPtyExitRecords(path)
  records[info.key] = {
    key: info.key,
    pid: info.pid,
    code: info.exit.code,
    signal: info.exit.signal,
    at: info.exit.at,
    tail: plainTail(info.tail),
  }
  const newest = Object.values(records)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, MAX_RECORDS)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(Object.fromEntries(newest.map((r) => [r.key, r])), null, 2), "utf8")
}
