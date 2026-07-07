/**
 * Framework-free pane logic for the file tree — extracted from the Solid
 * `FileTree.tsx` (issue #15, G3) so the React port shares the exact same
 * behavior instead of duplicating it. Everything here is pure functions
 * over the `Row` model (plus one node-only fs.watch helper), unit-tested
 * in `test/tui-react/filetree-pane-core.test.ts`; the Solid component
 * keeps consuming these so the two runtimes cannot drift.
 */

import { watch } from "node:fs"
import type { FileStatus } from "./git"
import type { Row } from "./rows"

/**
 * Map a status code to its theme token. Resolved at render time so a
 * theme switch reactively recolours pre-existing rows.
 */
export function statusToken(s: FileStatus): "warning" | "success" | "error" | "textMuted" | "info" {
  switch (s) {
    case "M":
      return "warning"
    case "A":
      return "success"
    case "D":
      return "error"
    case "?":
      return "textMuted"
    case "R":
    case "C":
    case "U":
    case "T":
      // Renames/copies/conflicts/typechanges are uncommon in the loop;
      // render them in info-blue to distinguish from the M/A/D/? majority.
      return "info"
  }
}

/**
 * Boil a raw `git ls-files` / `git status` error down to a single
 * human-friendly sentence. The thrown messages from `git.ts` look
 * like `git ls-files ... (cwd=/foo) exited with code 128: fatal: not
 * a git repository`. Most users don't need the full args / exit
 * code; we surface the common cases and keep the rest generic.
 * `t` is the caller's translate fn — Solid and React each pass their
 * own reactive one.
 */
export function summarizeGitError(raw: string, t: (key: string) => string): string {
  const m = raw.toLowerCase()
  if (m.includes("not a git repository")) return t("files.error.notGitRepo")
  if (m.includes("does not exist") || m.includes("enoent")) return t("files.error.pathMissing")
  if (m.includes("permission denied") || m.includes("eacces")) return t("files.error.permissionDenied")
  if (m.includes("git: not found") || m.includes("command not found")) return t("files.error.gitNotInstalled")
  // Fallback: strip the leading `git <args> (cwd=...)` boilerplate.
  const colon = raw.indexOf(": ")
  if (colon >= 0 && raw.startsWith("git ")) return raw.slice(colon + 2).trim() || t("files.error.gitFailed")
  return raw.trim() || t("files.error.gitFailed")
}

/**
 * Column widths for the `+N` / `-N` stats on the Changes tab. Computed
 * across the visible rows so every cell pads to the widest sibling —
 * without this, `+0 -202` and `+1 -1` end at the same right edge but
 * the `-` columns drift, which reads as misaligned. Width includes
 * the leading sign (`+`/`-`).
 */
export type StatWidths = { added: number; deleted: number }

export function computeStatWidths(rows: readonly Row[]): StatWidths {
  let added = 0
  let deleted = 0
  for (const row of rows) {
    if (row.kind !== "status") continue
    if (row.added != null) added = Math.max(added, String(row.added).length + 1)
    if (row.deleted != null) deleted = Math.max(deleted, String(row.deleted).length + 1)
  }
  return { added, deleted }
}

/**
 * Cell budget for a Changes-tab path. Tail-truncated to whatever the pane
 * leaves after the status char, the `+N`/`-N` stat columns, the inter-column
 * gaps, row padding, and the scrollbar — so the filename always survives and
 * only the leading directories elide.
 */
export function computePathBudget(paneWidth: number, w: StatWidths): number {
  const stats = (w.added > 0 ? w.added + 1 : 0) + (w.deleted > 0 ? w.deleted + 1 : 0)
  // row padding (2) + status glyph (1) + gap (1) + stats + scrollbar (1) + slack (1).
  return Math.max(8, paneWidth - 6 - stats)
}

/** Render a `+N` / `-N` stat cell padded to the column width; a missing
 * count renders as blanks so the columns stay aligned. */
export function statCell(value: number | null | undefined, width: number, sign: "+" | "-"): string {
  // Deletions render the typographic minus (U+2212) — same glyph as the
  // sidebar's −N counter, same 1-cell width as ASCII "-".
  const glyph = sign === "-" ? "−" : sign
  return value == null ? " ".repeat(width) : `${glyph}${value}`.padStart(width)
}

/** Toggle a directory path in the expansion set (immutably). */
export function toggleDir(expanded: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** What a hierarchy keypress should do — mutate the expansion set or move
 * the cursor. `null` means no-op. */
export type NavAction = { type: "expand" | "collapse"; path: string } | { type: "cursor"; index: number }

/** `l` — hierarchy navigation only. On a closed dir, expand it; on
 * an open dir, step into its first child; on a file, no-op (use
 * `enter` to open). Keeping `l` purely structural lets the user roam
 * through the tree without accidentally pulling the file into the
 * preview pane. */
export function expandOrDescendAction(rows: readonly Row[], cursorIndex: number): NavAction | null {
  const row = rows[cursorIndex]
  if (!row || row.kind !== "dir") return null
  if (!row.expanded && row.hasChildren) return { type: "expand", path: row.path }
  if (row.expanded && cursorIndex + 1 < rows.length) return { type: "cursor", index: cursorIndex + 1 }
  return null
}

/** `h` — collapse the current directory, or jump to the parent dir
 * (depth - 1) walking upward in rows. All-tab behavior; the caller
 * gates on the active tab. */
export function collapseOrParentAction(rows: readonly Row[], cursorIndex: number): NavAction | null {
  const row = rows[cursorIndex]
  if (!row) return null
  // Open dir → collapse.
  if (row.kind === "dir" && row.expanded) return { type: "collapse", path: row.path }
  if (row.kind !== "dir" && row.kind !== "file") return null
  const targetDepth = row.depth - 1
  if (targetDepth < 0) return null
  for (let j = cursorIndex - 1; j >= 0; j--) {
    const candidate = rows[j]
    if (!candidate) continue
    if (candidate.kind === "dir" && candidate.depth === targetDepth) return { type: "cursor", index: j }
  }
  return null
}

/**
 * Viewport follow: each row renders as a height-1 box, so its y-offset
 * inside the scrollbox content equals its index. When the cursor moves
 * past the visible window (either edge), return the scrollTop that puts
 * the cursor row just inside the viewport; `null` means don't scroll.
 */
export function followScrollTop(scrollTop: number, viewportHeight: number, cursorIndex: number): number | null {
  if (viewportHeight <= 0) return null
  if (cursorIndex < scrollTop) return cursorIndex
  if (cursorIndex >= scrollTop + viewportHeight) return cursorIndex - viewportHeight + 1
  return null
}

/** Whether an fs-watch event under the worktree should trigger a refresh —
 * `.git` internals and node_modules churn are noise. */
export function watchEventRelevant(filename: string): boolean {
  if (filename === ".git" || filename.startsWith(".git/") || filename.startsWith(".git\\")) return false
  if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return false
  return true
}

type EventedWatcher = ReturnType<typeof watch> & { on(event: "error", listener: (err: Error) => void): void }

/**
 * Recursive fs watch over a worktree with a 500ms trailing debounce.
 * Returns a disposer. Errors are swallowed (the `r` keystroke remains as
 * the escape hatch); an unwatchable path degrades to manual refresh.
 * Opt-in at the call site via `KOBE_FILETREE_WATCH=1` — on large repos a
 * recursive watcher can overwhelm the TUI process before the user does
 * anything.
 */
export function watchWorktree(path: string, onChange: () => void, debounceMs = 500): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: EventedWatcher | null = null
  try {
    watcher = watch(path, { recursive: true }, (_event, filename) => {
      if (filename == null) return
      if (!watchEventRelevant(filename.toString())) return
      if (debounceTimer != null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        onChange()
      }, debounceMs)
    }) as EventedWatcher
    watcher.on("error", () => {
      // Swallow — the `r` keystroke remains as the escape hatch.
    })
  } catch {
    // Path missing or not watchable — fall back to manual refresh.
  }
  return () => {
    if (debounceTimer != null) clearTimeout(debounceTimer)
    if (watcher != null) watcher.close()
  }
}
