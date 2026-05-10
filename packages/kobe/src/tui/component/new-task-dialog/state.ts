/**
 * Pure state-machine helpers for the new-task dialog.
 *
 * Lifted out of `src/tui/app.tsx` so the dialog's logic — field
 * cycling, repo-list assembly, substring filtering, picker windowing,
 * repo-path validation, branch enumeration — can be unit-tested
 * without standing up the dialog stack or opentui. None of these
 * functions touch Solid, opentui, or the dialog context; they are
 * effectively reducers + pure helpers.
 *
 * The JSX shell (`./dialog.tsx`) imports these and wires them to
 * signals. Keep this file Solid-free.
 */

import * as fs from "node:fs"

/* --------------------------------------------------------------------- */
/*  Public types                                                          */
/* --------------------------------------------------------------------- */

/** Result of a successful submit. */
export type NewTaskInput = { repo: string; baseRef: string }

/**
 * Three field states for repo selection:
 *   - "repoPicker" (default, primary path) — picker is focused, the
 *     custom-path input below is dim and inert. Arrow keys navigate
 *     the list; enter commits the highlighted repo and advances to
 *     baseRef.
 *   - "repoCustom" — the user explicitly tabbed into the input to
 *     type a path that isn't in the picker. Last-priority surface.
 *   - "baseRef" — branch field.
 * Tab cycles repoPicker → repoCustom → baseRef → repoPicker.
 */
export type Field = "repoPicker" | "repoCustom" | "baseRef"

/** Default base ref when the user leaves the field blank. */
export const DEFAULT_BASE_REF = "main"

/** Picker windowing cap. Matches the slash dropdown's `slashWindow`. */
export const PICKER_MAX_VISIBLE = 8

export type PickerWindow = {
  items: readonly string[]
  start: number
  total: number
}

/* --------------------------------------------------------------------- */
/*  Pure helpers                                                          */
/* --------------------------------------------------------------------- */

/**
 * Strip CR/LF from a single-line input value. opentui's `<input>`
 * happily inserts a literal `\n` when the user presses enter inside a
 * focused field — even though the same press also fires `onSubmit` —
 * so the value rendered back to the field shows the stray newline as
 * a glyph (looks like an extra "n" on macOS terminals). We sanitize at
 * the onInput edge so the signal never carries a newline; the
 * onSubmit handler still fires and commits the trimmed-but-newline-
 * free value.
 *
 * Exported so the rename-task dialog (which shares the same opentui
 * input quirk) can reuse it without re-importing from app.tsx.
 */
export function stripNewlines(v: string): string {
  return v.replace(/[\r\n]+/g, "")
}

/**
 * Advance the field-cycle state. Order is repoPicker → repoCustom →
 * baseRef → repoPicker.
 */
export function nextField(field: Field): Field {
  return field === "repoPicker" ? "repoCustom" : field === "repoCustom" ? "baseRef" : "repoPicker"
}

/**
 * Build the deduped repo option list. `defaultRepo` (cwd at launch)
 * is always first; user-saved repos follow, deduped against the cwd
 * and any whitespace-only entries. Returns a fresh array on each call
 * so the caller can pass it straight into a memo.
 */
export function computeRepoOptions(defaultRepo: string, savedRepos: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [defaultRepo, ...savedRepos]) {
    const t = p.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * Case-insensitive substring filter for the repo picker. When the
 * picker (not the custom-path input) has focus, the filter is
 * bypassed so the user can browse the full list with arrow keys
 * regardless of whatever they typed earlier. Caller decides whether
 * to apply the filter by checking field === "repoCustom".
 */
export function filterRepos(all: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return all
  return all.filter((p) => p.toLowerCase().includes(q))
}

/**
 * Case-insensitive substring filter for the branch picker. Same rules
 * as the repo filter — empty query returns everything; non-empty does
 * a substring match.
 */
export function filterBranches(all: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return all
  return all.filter((b) => b.toLowerCase().includes(q))
}

/**
 * Windowing helper — same shape as the slash dropdown's
 * `slashWindow`. Caps visible rows so a repo with 80+ branches doesn't
 * push the rest of the dialog off-screen; the window scrolls to keep
 * the cursor in view.
 */
export function windowAround(list: readonly string[], cursor: number, cap = PICKER_MAX_VISIBLE): PickerWindow {
  const total = list.length
  if (total <= cap) return { items: list, start: 0, total }
  const half = Math.floor(cap / 2)
  let start = Math.max(0, cursor - half)
  if (start + cap > total) start = total - cap
  return { items: list.slice(start, start + cap), start, total }
}

/**
 * Clamp the picker cursor to the available range [0, list.length - 1].
 * Returns 0 for empty lists.
 */
export function clampCursor(cursor: number, listLength: number): number {
  if (listLength <= 0) return 0
  return Math.max(0, Math.min(listLength - 1, cursor))
}

/**
 * Validate a repo path entered in the new-task dialog. Returns null
 * when the path looks like a usable git repo, or a human-readable
 * reason string otherwise. The dialog renders the reason inline and
 * blocks submission so a typo'd path doesn't get persisted as
 * `lastNewTaskRepo` and can't drag every subsequent `runTask` into
 * `git worktree add` failures.
 *
 * Two checks (in order):
 *   1. The path exists and is a directory. We do NOT recursively
 *      create — a non-existent path is almost always a typo, not a
 *      "please mkdir for me" request.
 *   2. `git -C <path> rev-parse --git-dir` succeeds. This catches
 *      both "exists but not a repo" and "exists but git is unhappy"
 *      with a single check.
 */
export function validateRepoPath(repo: string): string | null {
  const trimmed = repo.trim()
  if (!trimmed) return "repo path is required"
  // existsSync + statSync.isDirectory in one shot.
  let stat: import("node:fs").Stats
  try {
    stat = fs.statSync(trimmed)
  } catch {
    return `path does not exist: ${trimmed}`
  }
  if (!stat.isDirectory()) return `not a directory: ${trimmed}`
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: trimmed,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (out.status !== 0) return `not a git repository: ${trimmed}`
  } catch {
    return `not a git repository: ${trimmed}`
  }
  return null
}

/**
 * List local branches in the given repo, sorted with the default
 * branch first when present. Synchronous — repo enumeration is a
 * one-shot call driven by the dialog's repo-field changes, so paying
 * for an async boundary buys nothing. Returns [] on any error so the
 * picker just silently degrades to the free-text input.
 */
export function listLocalBranches(repo: string): string[] {
  if (!repo) return []
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
    })
    if (out.status !== 0) return []
    return (out.stdout as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => {
        // Default branches first.
        const score = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : n === "develop" ? 2 : 3)
        const sa = score(a)
        const sb = score(b)
        if (sa !== sb) return sa - sb
        return a.localeCompare(b)
      })
  } catch {
    return []
  }
}

/**
 * Resolve the baseRef the dialog should submit. Prefers the currently
 * highlighted branch in the picker over the typed text — free-text
 * only kicks in when nothing matches (e.g. typed a tag / commit SHA
 * the local branch list doesn't know). Returns the trimmed typed text
 * (or DEFAULT_BASE_REF) when no list match is available.
 */
export function resolveBaseRef(typed: string, filteredBranches: readonly string[], cursor: number): string {
  const picked = filteredBranches[cursor]
  if (picked) return picked
  const t = typed.trim()
  return t || DEFAULT_BASE_REF
}
