/**
 * Disk persistence for composer prompt history (KOB-157).
 *
 * Mirrors Claude Code's `~/.claude/history.jsonl` design (see
 * `refs/claude-code/src/hooks/useArrowKeyHistory.tsx`): a single global
 * JSONL file scoped per-project, append-only on every submit, eagerly
 * loaded at boot. Differences vs. Claude Code:
 *
 *   - Path: `<kobeStateDir()>/composer-history.jsonl`, so the
 *     `KOBE_HOME_DIR` env var still isolates dev / dev:test /
 *     dev:sandbox (see `packages/kobe/CLAUDE.md` § Development
 *     environments).
 *   - kobe has no `pastedContents` concept — images are expanded to
 *     `@path` references inline at submit time and stored verbatim.
 *   - No per-line `sessionId`. Claude Code uses it to prioritize the
 *     current invocation's prompts in the up-arrow walk; kobe's
 *     up-arrow walks the in-memory per-tab ring only (tab ids are
 *     session-local — see `composer/history.ts`'s "scope of replay"
 *     note), so the field would be vestigial.
 *
 * Per-line shape:
 *
 *   {"display":"the prompt","timestamp":1715000000000,"project":"/abs/repo/root"}
 *
 * `display` is the raw stored value — including the leading `!` for
 * bash-mode submissions, just like the in-memory ring (so reload
 * preserves the bash recall path from KOB-151).
 *
 * Failure mode contract: every disk op is best-effort. The user's
 * keystroke flow never blocks on I/O, and a corrupt or missing file
 * degrades cleanly to "no history persisted." Errors are logged once
 * via `console.warn` and then swallowed.
 */

import { existsSync, readFileSync } from "node:fs"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { kobeStateDir } from "@/env"

/**
 * Total entries kept on disk across all projects. Above this, the
 * file is rewritten with the newest {@link DISK_HISTORY_CAP} entries
 * (cheap because the file is small and the rewrite is async).
 *
 * Claude Code caps at 100 per-project on read but doesn't prune the
 * file itself — old entries simply become unreachable. kobe prunes on
 * disk so the file doesn't grow without bound on long-lived installs.
 */
export const DISK_HISTORY_CAP = 1000

export type DiskHistoryEntry = {
  readonly display: string
  readonly timestamp: number
  /**
   * Absolute path of the repo (worktree's parent project root) the
   * task was submitted from, or `undefined` when no task was active
   * (the literal `"global"` history key — rare in practice). Used by
   * the Ctrl+R palette to scope rows to the current project.
   */
  readonly project: string | undefined
  /**
   * Task id at submission time. `bootstrapHistory` replays an entry
   * under its `taskId` key when that task is still alive on the next
   * boot (so the same task's ↑ walks across-session history); when
   * the task has been deleted between sessions, the entry falls back
   * to the `project-<root>` key and surfaces only via Ctrl+R. Older
   * files written before this field existed parse with
   * `taskId === undefined` and follow the same fallback path.
   */
  readonly taskId: string | undefined
}

/** Default on-disk path. Tests can override via the `path` arg. */
export function defaultHistoryPath(): string {
  return join(kobeStateDir(), "composer-history.jsonl")
}

/**
 * Sync read on boot. Returns surviving entries sorted oldest → newest
 * by `timestamp`. Missing file = empty. Malformed lines are skipped
 * with a single warning aggregating the count.
 *
 * Sort by timestamp (not file position) because concurrent appends to
 * the same file can interleave at byte level even though each line's
 * write is POSIX-atomic. The on-disk `timestamp` field is captured
 * synchronously at push time, so it remains the canonical ordering
 * key even if two TUIs (or one TUI pushing quickly) race the writes.
 *
 * Sync (not async) because the TUI's boot path is synchronous —
 * loading before the first composer mount lets us replay into the
 * in-memory STORE before any palette query lands. The file is small
 * enough that a sync read is cheap (sub-ms for typical sizes).
 */
export function loadFromDisk(path: string = defaultHistoryPath()): DiskHistoryEntry[] {
  if (!existsSync(path)) return []
  let text: string
  try {
    // `readFileSync` is fine here — see note above. Switch to streaming
    // only if real-world files start landing in the multi-MB range.
    text = readFileSync(path, "utf8")
  } catch (err) {
    console.warn(`[kobe] could not read composer history at ${path}: ${err instanceof Error ? err.message : err}`)
    return []
  }
  const lines = text.split("\n")
  const out: DiskHistoryEntry[] = []
  let malformed = 0
  for (const line of lines) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<DiskHistoryEntry>
      if (typeof parsed.display !== "string" || typeof parsed.timestamp !== "number") {
        malformed += 1
        continue
      }
      out.push({
        display: parsed.display,
        timestamp: parsed.timestamp,
        project: typeof parsed.project === "string" ? parsed.project : undefined,
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
      })
    } catch {
      malformed += 1
    }
  }
  if (malformed > 0) {
    console.warn(`[kobe] composer history: skipped ${malformed} malformed line(s) in ${path}`)
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

/**
 * Serial write queue. Even though POSIX `appendFile` writes <PIPE_BUF
 * (typically 4KB) atomically, two concurrent `appendFile` calls can
 * still complete in *opposite* order from how they were issued — the
 * OS interleaves them by scheduling, not by submission time. That
 * scrambles the file's chronology and breaks the
 * loadFromDisk-by-file-order assumption.
 *
 * Chaining every append onto the same promise lets the test pass
 * deterministically AND matches the user's mental model: prompts
 * land on disk in the same order they were submitted, period. Cost
 * is negligible (one fs call per push, which is sub-ms anyway).
 *
 * The chain swallows errors so a single bad write doesn't poison
 * later ones.
 */
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Best-effort append. Returns a promise that resolves when *this*
 * call's write has landed; callers can `void` it (fire-and-forget)
 * or `await` it (e.g. tests proving the write reached disk). Failure
 * logs once via `console.warn` and the chain keeps going.
 *
 * Ensures the parent directory exists (first append on a fresh
 * install needs to create `~/.kobe/`).
 */
export function appendToDisk(entry: DiskHistoryEntry, path: string = defaultHistoryPath()): Promise<void> {
  const next = writeQueue.then(async () => {
    try {
      const dir = dirname(path)
      await mkdir(dir, { recursive: true })
      const line = `${JSON.stringify(entry)}\n`
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 })
    } catch (err) {
      console.warn(`[kobe] composer history append failed: ${err instanceof Error ? err.message : err}`)
    }
  })
  writeQueue = next
  return next
}

/**
 * Drain the write queue. Tests use this to deterministically wait for
 * fire-and-forget pushes to land on disk before asserting. Production
 * code shouldn't need to call it.
 */
export function flushPendingWrites(): Promise<void> {
  return writeQueue
}

/**
 * Rewrite the file with only the newest {@link DISK_HISTORY_CAP}
 * entries when the on-disk count exceeds the cap. Cheap because the
 * file is small. Called opportunistically from {@link appendToDisk}'s
 * caller — the kobe in-memory layer counts disk writes and triggers
 * this every ~50 appends past the cap, not on every push.
 *
 * Atomic via tmp-file + rename so a crash mid-prune doesn't corrupt
 * the history.
 */
export async function pruneToCap(path: string = defaultHistoryPath(), cap: number = DISK_HISTORY_CAP): Promise<void> {
  try {
    if (!existsSync(path)) return
    const text = await readFile(path, "utf8")
    const lines = text.split("\n").filter((l) => l.length > 0)
    if (lines.length <= cap) return
    const keep = lines.slice(lines.length - cap)
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${keep.join("\n")}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    console.warn(`[kobe] composer history prune failed: ${err instanceof Error ? err.message : err}`)
  }
}
