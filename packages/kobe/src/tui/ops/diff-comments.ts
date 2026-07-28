/**
 * Line-anchored review comments on the read-only diff view — the
 * framework-free half (types, prompt format, unified-row mapping, the
 * kv-backed per-task store). The React UI lives in
 * `src/tui-react/ops/preview-review.tsx`; wiring into the engine PTY in
 * `src/tui-react/workspace/TerminalTabs.tsx`.
 *
 * The prompt format is ported from orca's `src/shared/diff-comments-format.ts`
 * (File / Line-or-range / quote-escaped User comment, blank-line separated)
 * — deliberately dead simple: it's the contract between review notes and
 * whichever engine consumes them.
 *
 * Anchoring ceiling (deliberate): a comment is file path + the display line
 * number of the diff it was written against. If the diff changes and lines
 * drift, the comment stays attached to file+stored line — no re-anchoring.
 */

import { randomUUID } from "node:crypto"

/** One review note. `line`/`startLine` are display line numbers as shown in
 * the diff gutter (new-file numbers for added/context rows, old-file for
 * removed rows). */
export type DiffComment = {
  readonly id: string
  /** Worktree-relative path of the file the diff belongs to. */
  readonly filePath: string
  /** Inclusive range start; `<= line` when present. */
  readonly startLine?: number
  readonly line: number
  readonly body: string
  readonly createdAt: number
  /** Set once the note was handed to the engine session; unsent notes are
   *  the pending send batch. */
  readonly sentAt?: number
}

export function formatDiffComment(c: Pick<DiffComment, "filePath" | "startLine" | "line" | "body">): string {
  const escaped = c.body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")
  const location =
    c.startLine !== undefined && c.startLine !== c.line ? `Lines: ${c.startLine}-${c.line}` : `Line: ${c.line}`
  return [`File: ${c.filePath}`, location, `User comment: "${escaped}"`].join("\n")
}

export function formatDiffComments(
  comments: readonly Pick<DiffComment, "filePath" | "startLine" | "line" | "body">[],
): string {
  return comments.map(formatDiffComment).join("\n\n")
}

export function unsentComments(comments: readonly DiffComment[]): readonly DiffComment[] {
  return comments.filter((c) => c.sentAt === undefined)
}

export function markAllSent(comments: readonly DiffComment[], now: number): readonly DiffComment[] {
  return comments.map((c) => (c.sentAt === undefined ? { ...c, sentAt: now } : c))
}

/* ------------------- unified-diff row mapping ------------------- */

/** One visible row of the unified `<diff>` view. `line` is the number the
 * gutter displays for it (mirrors opentui's `buildUnifiedView`). */
export type DiffRow = {
  readonly kind: "add" | "del" | "ctx"
  readonly line: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Map a unified diff to the row list opentui's DiffRenderable renders
 * (unified view, wrapMode "none"): row index i here is line index i for
 * `setLineColor`/scroll. Only `+`/`-`/` ` lines inside hunks are rows;
 * headers and `\ No newline` markers are not rendered.
 */
export function unifiedDiffRows(diff: string): readonly DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of diff.split("\n")) {
    const m = HUNK_HEADER.exec(line)
    if (m) {
      oldLine = Number(m[1])
      newLine = Number(m[2])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    const c = line[0]
    if (c === "+") rows.push({ kind: "add", line: newLine++ })
    else if (c === "-") rows.push({ kind: "del", line: oldLine++ })
    else if (c === " ") {
      rows.push({ kind: "ctx", line: newLine })
      oldLine++
      newLine++
    } else if (c !== "\\") inHunk = false // next file header / end of diff
  }
  return rows
}

/**
 * The line/range a new comment at `cursor` (with optional `anchor` row from
 * range-select) should record. Display lines are non-monotonic across mixed
 * +/- rows and hunk gaps; a range whose endpoints don't order cleanly
 * collapses to the single end line (ponytail: no smarter mapping — the note
 * body carries the context anyway).
 */
export function commentRange(
  rows: readonly DiffRow[],
  cursor: number,
  anchor: number | null,
): { line: number; startLine?: number } | null {
  const cursorRow = rows[cursor]
  if (!cursorRow) return null
  if (anchor == null || anchor === cursor) return { line: cursorRow.line }
  const first = rows[Math.min(anchor, cursor)]
  const last = rows[Math.max(anchor, cursor)]
  if (!first || !last || first.line >= last.line) return { line: cursorRow.line }
  return { line: last.line, startLine: first.line }
}

/* ------------------- review paint ------------------- */

export type ReviewPaintKind = "cursor" | "range" | "note"

/**
 * Row index → paint kind for the diff review overlay: unsent notes on this
 * file glow, the active range-select covers anchor..cursor, and the cursor
 * row wins over both.
 */
export function computeReviewPaint(
  rows: readonly DiffRow[],
  cursor: number,
  anchor: number | null,
  comments: readonly DiffComment[],
  filePath: string,
): ReadonlyMap<number, ReviewPaintKind> {
  const paint = new Map<number, ReviewPaintKind>()
  const unsent = unsentComments(comments).filter((c) => c.filePath === filePath)
  if (unsent.length > 0) {
    rows.forEach((row, i) => {
      if (unsent.some((c) => (c.startLine ?? c.line) <= row.line && row.line <= c.line)) paint.set(i, "note")
    })
  }
  if (anchor != null) {
    const lo = Math.min(anchor, cursor)
    const hi = Math.max(anchor, cursor)
    for (let i = lo; i <= hi; i++) paint.set(i, "range")
  }
  paint.set(cursor, "cursor")
  return paint
}

/* ------------------- per-task store (kv-backed) ------------------- */

/** Kv key holding a task's `DiffComment[]` — same per-task keying as the
 * `terminalTabs.<taskId>` snapshots, so notes survive pane switches and TUI
 * restarts through the existing state file. */
export function diffCommentsKey(taskId: string): string {
  return `diffComments.${taskId}`
}

export type NewDiffComment = Pick<DiffComment, "filePath" | "startLine" | "line" | "body">

/** What the diff view needs to read/add/send review notes. */
export interface DiffReviewApi {
  readonly comments: readonly DiffComment[]
  add(input: NewDiffComment): void
  /** Send ALL of the task's unsent notes as one prompt, then mark them sent. */
  send(): void
}

/** Structural slice of the TUI's KV context. */
export type DiffCommentsKv = {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

/**
 * Build the review handle over the kv store + the engine-send seam (the
 * same PTY paste+submit path the Create-PR prompt uses — engine-neutral).
 * Handlers re-read kv at call time so they never act on a stale snapshot.
 */
export function buildDiffReview(
  kv: DiffCommentsKv,
  taskId: string,
  sendToEngine: (text: string) => void,
): DiffReviewApi {
  const key = diffCommentsKey(taskId)
  const read = (): readonly DiffComment[] => (kv.get(key, []) as DiffComment[] | null) ?? []
  return {
    comments: read(),
    add(input) {
      kv.set(key, [...read(), { ...input, id: randomUUID(), createdAt: Date.now() }])
    },
    send() {
      const all = read()
      const unsent = unsentComments(all)
      if (unsent.length === 0) return
      sendToEngine(formatDiffComments(unsent))
      kv.set(key, markAllSent(all, Date.now()))
    },
  }
}
