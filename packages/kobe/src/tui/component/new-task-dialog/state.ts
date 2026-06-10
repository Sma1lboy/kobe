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

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Readable } from "node:stream"
import { matchPathGlob } from "@/lib/path-glob"
import type { VendorId } from "@/types/vendor"

type EventedCloneProcess = {
  readonly stderr: Readable | null
  on(event: "error", listener: (err: Error) => void): void
  on(event: "close", listener: (code: number | null) => void): void
}

/* --------------------------------------------------------------------- */
/*  Public types                                                          */
/* --------------------------------------------------------------------- */

/**
 * Result of a successful submit. `cloned` is set when the user came in
 * via the New Repo tab — the clone has already completed at this point
 * and `repo` is the freshly-cloned worktree path. The caller uses the
 * presence of `cloned` to persist `lastClonedRepoParent` and add `repo`
 * to the saved-repos list so it shows up in the existing-tab picker
 * next time.
 */
/**
 * Dialog result. Two shapes, discriminated by `mode`:
 *   - create (default) — make a fresh task on `repo` at `baseRef`.
 *   - adopt — import one or more EXISTING git worktrees as tasks
 *     (KOB-256). `adopt` carries the chosen worktrees; the caller loops
 *     `orchestrator.adoptWorktree` over them.
 */
export type NewTaskInput =
  | {
      mode?: "create"
      repo: string
      baseRef: string
      /** Engine the task runs on. Defaults to the user's last-selected vendor. */
      vendor: VendorId
      cloned?: { parentDir: string }
    }
  | {
      mode: "adopt"
      repo: string
      vendor: VendorId
      adopt: readonly { worktreePath: string; branch: string }[]
    }

/**
 * Which sub-tab the dialog is showing:
 *   - "existing" — pick an existing local repo + branch (legacy behavior).
 *   - "clone"    — clone a remote repo, then create a task on the clone.
 *
 * Switched via Ctrl+[ / Ctrl+] while the dialog is open. With only two
 * tabs the chord pair behaves as a toggle.
 */
export type DialogTab = "existing" | "clone" | "adopt"

/** Cycle helper for the tab strip: existing → clone → adopt → existing. */
export function nextDialogTab(tab: DialogTab): DialogTab {
  if (tab === "existing") return "clone"
  if (tab === "clone") return "adopt"
  return "existing"
}

/**
 * Field states for the dialog. The "existing" tab uses `repo` / `baseRef`
 * / `confirm`. The "clone" tab uses `cloneUrl` / `cloneParent` /
 * `cloneFolder` / `cloneBaseRef` / `confirm` — same `confirm` value is
 * shared so the bottom-row Create button works identically on both
 * surfaces. Tab cycling stays inside a single sub-tab's field list.
 */
export type Field =
  | "repo"
  | "baseRef"
  | "cloneUrl"
  | "cloneParent"
  | "cloneFolder"
  | "cloneBaseRef"
  | "adoptFilter"
  | "confirm"

/**
 * Which list the unified picker should render under the repo input.
 *   - "saved" — substring-filtered against the curated saved-repo
 *     list (cwd + /add-repo entries). Default when the input is empty
 *     or doesn't look like a path.
 *   - "browse" — directory drill-down. Engaged when the input looks
 *     like a path (`/...` or `~/...`) AND doesn't exactly match a
 *     saved repo — exact-match keeps "saved" so the cwd default doesn't
 *     jarringly render as a parent-dir browse on dialog open.
 */
export type PickerMode = "saved" | "browse"

/**
 * Decide which list the unified picker should render for the current
 * input. `repoOptions` is the assembled saved-repo list (already
 * deduped by `computeRepoOptions`) — pass it so we can short-circuit
 * to "saved" when the typed value is an exact match (e.g. the
 * cwd-prefilled state on dialog open).
 */
export function pickerModeFor(value: string, repoOptions: readonly string[]): PickerMode {
  const trimmed = value.trim()
  if (repoOptions.includes(trimmed)) return "saved"
  if (trimmed.startsWith("~")) return "browse"
  if (trimmed.includes("/")) return "browse"
  return "saved"
}

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
 * Advance the field-cycle state. Tab walks within the current sub-tab's
 * field list:
 *   existing:   repo → baseRef → confirm → repo
 *   clone:      cloneUrl → cloneParent → cloneFolder → cloneBaseRef → confirm → cloneUrl
 *
 * `confirm` is shared between both sub-tabs — the caller is responsible
 * for resetting to the right "first field" when the user switches tabs.
 */
export function nextField(field: Field, tab: DialogTab = "existing"): Field {
  if (tab === "clone") {
    if (field === "cloneUrl") return "cloneParent"
    if (field === "cloneParent") return "cloneFolder"
    if (field === "cloneFolder") return "cloneBaseRef"
    if (field === "cloneBaseRef") return "confirm"
    return "cloneUrl"
  }
  if (tab === "adopt") {
    // Two stops: the glob-filter input and the Create (= Adopt) button.
    // List navigation is up/down on the rows, not Tab.
    return field === "adoptFilter" ? "confirm" : "adoptFilter"
  }
  if (field === "repo") return "baseRef"
  if (field === "baseRef") return "confirm"
  return "repo"
}

/** First field for a sub-tab (used when switching tabs). */
export function firstFieldFor(tab: DialogTab): Field {
  if (tab === "clone") return "cloneUrl"
  if (tab === "adopt") return "adoptFilter"
  return "repo"
}

/**
 * Filter adoptable worktrees by a path glob (KOB-256). Empty glob → the
 * full list. Matches against the absolute path AND the basename, so a
 * bare `feature-*` works without typing the full directory. Uses Bun's
 * built-in `Glob` (zero-dep). An invalid pattern matches nothing rather
 * than throwing — the dialog keeps rendering.
 */
export function filterAdoptableByGlob<T extends { path: string }>(list: readonly T[], glob: string): readonly T[] {
  const pattern = glob.trim()
  if (!pattern) return list
  return list.filter((w) => matchPathGlob(pattern, w.path))
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
 * Case-insensitive substring filter for the repo picker. Empty query
 * returns the full list verbatim.
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
 * Read the current branch of the given repo (whatever HEAD points at).
 * Returns null when the path isn't a repo, HEAD is detached, or git
 * errors out. The dialog uses this to prefill the baseRef field with
 * the repo's actual current branch instead of a hardcoded "main", so
 * a worktree forked from a feature branch defaults to that feature
 * branch rather than silently jumping to main.
 */
export function getCurrentBranch(repo: string): string | null {
  if (!repo) return null
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (out.status !== 0) return null
    const name = (out.stdout as string).trim()
    if (!name || name === "HEAD") return null
    return name
  } catch {
    return null
  }
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

/* --------------------------------------------------------------------- */
/*  Directory drill-down for the custom-path input                        */
/* --------------------------------------------------------------------- */

/**
 * Expand a leading `~` to the user's home directory. Supports `~` alone
 * and `~/...`-prefixed paths only (no `~user/` lookups — rare; not
 * worth the parsing complexity here). The fs / git helpers don't expand
 * `~` themselves, so callers must resolve before validating or
 * spawning git.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return os.homedir() + p.slice(1)
  return p
}

export type PathSplit = { base: string; filter: string }

/**
 * Split a partially-typed path into:
 *   - `base`: the directory we should readdir for suggestions (always
 *     ends with `/`, or is empty if the input has no directory portion
 *     yet).
 *   - `filter`: the partial leaf the user is currently typing (used as
 *     a case-insensitive prefix match against the directory listing).
 *
 *   `/Users/`           → { base: "/Users/", filter: "" }
 *   `/Users/me/proj`    → { base: "/Users/me/", filter: "proj" }
 *   `~/p`               → { base: "<home>/", filter: "p" }
 *   `~`                 → { base: "<home>/", filter: "" }
 *   `relative/path`     → { base: "relative/", filter: "path" }
 *   `foo`               → { base: "", filter: "foo" }
 *
 * `~`-relative inputs are expanded so the base is a real filesystem
 * path that readdir can use; preserving the `~/` prefix in the
 * rendered input is the caller's job — see `joinDrill`.
 */
export function splitPathForDirSuggest(value: string): PathSplit {
  if (!value) return { base: "", filter: "" }
  // Treat bare `~` as `~/` so we list the home directory.
  const normalized = value === "~" ? "~/" : value
  const expanded = expandHome(normalized)
  if (expanded.endsWith("/")) return { base: expanded, filter: "" }
  const lastSlash = expanded.lastIndexOf("/")
  if (lastSlash === -1) return { base: "", filter: expanded }
  return { base: expanded.slice(0, lastSlash + 1), filter: expanded.slice(lastSlash + 1) }
}

/**
 * Synchronously list direct subdirectories of `base`. Returns [] on any
 * fs error (path doesn't exist, permission denied, etc.) so the picker
 * silently degrades to free-text typing. Sorted alphabetically — the
 * filter (`filterSubdirs`) decides what survives.
 *
 * Hidden entries (leading `.`) are kept; `filterSubdirs` is responsible
 * for hiding them unless the user explicitly types a `.`.
 */
export function listSubdirs(base: string): readonly string[] {
  if (!base) return []
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name)
    }
    return out.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Filter the subdirectory list for the picker. Two rules:
 *
 *   1. Case-insensitive **prefix** match (not substring) — typing
 *      `proj` finds `projects/` but not `my-projects/`. Prefix matches
 *      what users expect from shell tab-completion and keeps the list
 *      tight as the user types deeper.
 *   2. Entries starting with `.` are hidden unless the filter itself
 *      starts with `.` — same convention as `ls`.
 */
export function filterSubdirs(all: readonly string[], filter: string): readonly string[] {
  const f = filter.toLowerCase()
  const showHidden = f.startsWith(".")
  const visible = showHidden ? all : all.filter((n) => !n.startsWith("."))
  if (!f) return visible
  return visible.filter((n) => n.toLowerCase().startsWith(f))
}

/**
 * Compose the new input value when the user drills into a highlighted
 * subdirectory suggestion. The `~/` prefix is preserved if the user
 * typed one (so the display stays readable) — `baseExpanded` is the
 * fs-real path readdir used, and we rewrap it in `~/` form when
 * applicable.
 */
export function joinDrill(typedValue: string, baseExpanded: string, name: string): string {
  const out = `${baseExpanded + name}/`
  if (typedValue.startsWith("~")) {
    const home = os.homedir()
    if (out === `${home}/`) return "~/"
    if (out.startsWith(`${home}/`)) return `~${out.slice(home.length)}`
  }
  return out
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

/* --------------------------------------------------------------------- */
/*  Clone tab — URL parsing, folder naming, target validation, spawn      */
/* --------------------------------------------------------------------- */

/**
 * Derive a sensible default folder name from a git URL. Strips trailing
 * `/`, takes the part after the last `/` or `:` (SCP-form support), and
 * strips a trailing `.git`. Returns "" for inputs we can't make sense of.
 *
 *   https://github.com/foo/bar.git    → "bar"
 *   git@github.com:foo/bar.git        → "bar"
 *   ssh://git@host:22/foo/bar         → "bar"
 *   https://example.com/path/repo/    → "repo"
 *   not-a-url                         → "not-a-url"
 */
export function deriveFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const lastSlash = trimmed.lastIndexOf("/")
  const lastColon = trimmed.lastIndexOf(":")
  const cutAt = Math.max(lastSlash, lastColon)
  const tail = cutAt >= 0 ? trimmed.slice(cutAt + 1) : trimmed
  return tail.replace(/\.git$/i, "")
}

/**
 * Soft-validate a git URL. We don't want to over-restrict here — the
 * dialog defers real validation to `git clone` itself (whose error
 * message we surface inline). The pre-check only rejects obviously
 * empty / whitespace input so the Create button can stay disabled.
 *
 * Returns null when the URL looks plausibly clone-able, or a reason
 * string otherwise.
 */
export function validateGitUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return "git URL is required"
  // Must contain either `://` (https / ssh / git) or `:` (SCP-form), or
  // be a local path. Refuse only completely formless single-token input.
  const hasProtocol = trimmed.includes("://")
  const hasScpSep = trimmed.includes("@") && trimmed.includes(":")
  const hasPathSep = trimmed.includes("/")
  if (!hasProtocol && !hasScpSep && !hasPathSep) {
    return `does not look like a git URL: ${trimmed}`
  }
  return null
}

/**
 * Validate the target clone directory before spawning `git`. Catches
 * the common foot-guns — empty folder name, path separators inside the
 * folder name, parent doesn't exist, target already exists — before we
 * spend a network round-trip just to have git complain.
 *
 * Returns null when the target is usable, or a reason string otherwise.
 * `parentDir` may use `~/...`; it's expanded here before fs checks.
 */
export function validateCloneTarget(parentDir: string, folder: string): string | null {
  const folderTrimmed = folder.trim()
  if (!folderTrimmed) return "folder name is required"
  if (folderTrimmed.includes("/") || folderTrimmed.includes("\\")) {
    return "folder name cannot contain path separators"
  }
  const parentTrimmed = parentDir.trim()
  if (!parentTrimmed) return "parent directory is required"
  const parentExpanded = expandHome(parentTrimmed)
  let parentStat: import("node:fs").Stats
  try {
    parentStat = fs.statSync(parentExpanded)
  } catch {
    return `parent directory does not exist: ${parentExpanded}`
  }
  if (!parentStat.isDirectory()) return `not a directory: ${parentExpanded}`
  const target = path.join(parentExpanded, folderTrimmed)
  if (fs.existsSync(target)) return `target already exists: ${target}`
  return null
}

/**
 * Compose the absolute target path the clone will land at. Caller is
 * expected to have already passed `validateCloneTarget`.
 */
export function resolveCloneTarget(parentDir: string, folder: string): string {
  return path.join(expandHome(parentDir.trim()), folder.trim())
}

/**
 * Pick a folder name that doesn't collide with an existing entry inside
 * `parentDir`. Returns `base` when nothing collides; otherwise tries
 * `${base}-2`, `${base}-3`, … until a free slot is found.
 *
 * Bails out early (returns `base` verbatim) when the parent path is
 * missing or not a directory — we don't want this helper to mask a
 * real validation error by handing back a fake-available name.
 *
 * Used by the New Repo tab's auto-derive-folder-from-URL effect so the
 * default folder name doesn't immediately fail `validateCloneTarget`
 * just because the user has already cloned the same repo before. The
 * user can still type a different name manually; the suffix only fills
 * the gap left by the URL-derived default.
 */
export function findAvailableFolderName(parentDir: string, base: string): string {
  const trimmed = base.trim()
  if (!trimmed) return base
  const parentExpanded = expandHome(parentDir.trim())
  if (!parentExpanded) return base
  try {
    const stat = fs.statSync(parentExpanded)
    if (!stat.isDirectory()) return base
  } catch {
    return base
  }
  if (!fs.existsSync(path.join(parentExpanded, trimmed))) return trimmed
  for (let n = 2; n < 1000; n++) {
    const candidate = `${trimmed}-${n}`
    if (!fs.existsSync(path.join(parentExpanded, candidate))) return candidate
  }
  return trimmed
}

/** Result of {@link cloneRepo}. */
export type CloneResult = { ok: true; path: string } | { ok: false; error: string }

/** Optional progress callback. Receives whatever line git wrote to stderr last. */
export type CloneProgress = (line: string) => void

/**
 * Async `git clone <url> <target>` wrapper. Streams stderr lines to
 * `onProgress` so the dialog can render a live "Cloning…" hint. Resolves
 * with `{ ok: true }` on exit code 0; otherwise returns the trimmed
 * stderr so the dialog can render it inline.
 *
 * Synchronous fallback was rejected — `spawnSync` would block the
 * opentui renderer for the duration of the clone, so esc / mouse / any
 * other dialog interaction freezes until git exits.
 */
export function cloneRepo(url: string, target: string, onProgress?: CloneProgress): Promise<CloneResult> {
  return new Promise<CloneResult>((resolve) => {
    let stderrBuf = ""
    try {
      const child = spawn("git", ["clone", "--progress", url, target], {
        stdio: ["ignore", "ignore", "pipe"],
      }) as unknown as EventedCloneProcess
      child.stderr?.setEncoding("utf-8")
      child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk
        if (onProgress) {
          // git emits CR-separated progress updates on the same line.
          // Split on either CR or LF so the latest fragment surfaces.
          const lines = chunk.split(/[\r\n]+/).filter((s) => s.trim().length > 0)
          const last = lines[lines.length - 1]
          if (last) onProgress(last)
        }
      })
      child.on("error", (err: Error) => {
        resolve({ ok: false, error: err.message })
      })
      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve({ ok: true, path: target })
          return
        }
        const tail =
          stderrBuf
            .split(/[\r\n]+/)
            .filter((s) => s.trim().length > 0)
            .pop() ?? `git clone exited with ${code}`
        resolve({ ok: false, error: tail })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
