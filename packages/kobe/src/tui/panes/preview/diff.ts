/**
 * Thin wrappers around `git diff` and file reads for the preview pane.
 *
 * Symmetric with `src/orchestrator/worktree/git.ts` (Stream B): we use
 * `node:child_process.spawnSync` rather than `Bun.spawnSync` because the
 * vitest worker pool runs under Node — `Bun` is undefined there. Node's
 * `spawnSync` is available in both runtimes so this stays portable for
 * production (Bun) and tests (Node) alike.
 *
 * Why sync spawn (not async): each call returns ≪1 KiB of stdout for
 * normal-size files and runs in <50 ms on a warm cache. The preview
 * pane runs them on tab open and on mode toggle — single-shot, not a
 * stream. Async spawn buys us nothing here and adds Promise plumbing.
 *
 * We never invoke a shell. Every arg goes through the array form, with
 * `shell: false` made explicit. `cwd` is required on every call; we
 * never inherit `process.cwd()`.
 *
 * `readDiff` returns the raw unified-diff text (the same format the
 * lifted `DiffLine` renderer consumes). When git exits non-zero (e.g.
 * the file is untracked) we return an empty string rather than throwing
 * — the UI shows "no diff content" and the user can switch to File mode.
 *
 * `readFile` shells to `cat` instead of `fs.readFileSync` so behavior
 * is uniform with `git diff` (both spawn-based, both bounded by
 * `MAX_BYTES`). It also matches the worktree's actual on-disk view —
 * when Stream B materializes a file we want exactly what's on disk.
 */

import { spawnSync } from "node:child_process"

/**
 * Cap any one read at 2 MiB. Beyond that the user almost certainly
 * doesn't want to render in the TUI; we truncate and append a banner.
 * Matches the buffer cap behavior tests expect.
 */
const MAX_BYTES = 2 * 1024 * 1024

/** Banner appended when output exceeds {@link MAX_BYTES}. */
const TRUNCATED_BANNER = "\n... [truncated by kobe — file exceeds 2 MiB] ..."

export type ReadResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string }

/**
 * Read the on-disk content of `relPath` inside `worktreePath`.
 *
 * - Returns `{ ok: true, text }` for normal files.
 * - Returns `{ ok: false, error }` for missing/unreadable files. The
 *   component renders the error inline so users can see why it failed
 *   (most likely: file deleted in a rebase, or symlink to nowhere).
 *
 * Path safety: we forbid `..` segments — the preview should only ever
 * read inside the worktree. The check is best-effort (we don't resolve
 * symlinks, so a malicious symlink could escape) but in practice the
 * preview is fed by Stream H (file tree) which only enumerates the
 * worktree itself.
 */
export async function readFile(worktreePath: string, relPath: string): Promise<ReadResult> {
  if (!worktreePath) return { ok: false, error: "no worktree path" }
  if (!relPath) return { ok: false, error: "no file path" }
  if (relPath.split("/").includes("..")) {
    return { ok: false, error: "path escapes worktree" }
  }
  const proc = spawnSync("cat", ["--", relPath], {
    cwd: worktreePath,
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_BYTES + 4096,
  })
  if (proc.status !== 0) {
    const err = (proc.stderr ?? "").trim() || `cat exited ${proc.status}`
    return { ok: false, error: err }
  }
  const raw = proc.stdout ?? ""
  if (raw.length > MAX_BYTES) {
    return { ok: true, text: raw.slice(0, MAX_BYTES) + TRUNCATED_BANNER, truncated: true }
  }
  return { ok: true, text: raw, truncated: false }
}

/**
 * Run `git diff <base> -- <relPath>` and return the unified-diff text.
 *
 * `base` is typically a branch name (`main`, `origin/main`) or a SHA;
 * we don't validate the format because `git` itself rejects malformed
 * refs — and propagating the git error message via `{ ok: false, error }`
 * gives the user a more actionable hint than our own validator would.
 *
 * When the file matches base exactly, git emits zero output — we still
 * return `ok: true` with `text: ""`, which the renderer surfaces as
 * "no diff content" via `DiffPane`.
 */
export async function readDiff(worktreePath: string, base: string, relPath: string): Promise<ReadResult> {
  if (!worktreePath) return { ok: false, error: "no worktree path" }
  if (!relPath) return { ok: false, error: "no file path" }
  if (!base) return { ok: false, error: "no diff base" }
  if (relPath.split("/").includes("..")) {
    return { ok: false, error: "path escapes worktree" }
  }
  const proc = spawnSync("git", ["diff", "--no-color", base, "--", relPath], {
    cwd: worktreePath,
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_BYTES + 4096,
  })
  // `git diff` returns 0 on success (with or without changes). Non-zero
  // = real failure (bad ref, etc.). Don't let the user wonder why an
  // empty pane appeared.
  if (proc.status !== 0) {
    const err = (proc.stderr ?? "").trim() || `git diff exited ${proc.status}`
    return { ok: false, error: err }
  }
  const raw = proc.stdout ?? ""
  if (raw.length > MAX_BYTES) {
    return { ok: true, text: raw.slice(0, MAX_BYTES) + TRUNCATED_BANNER, truncated: true }
  }
  return { ok: true, text: raw, truncated: false }
}

/**
 * Cheap probe: is `relPath` listed in `git status --porcelain`?
 *
 * The preview pane uses this to decide its default mode for a fresh
 * tab — if the file is changed and a diff base is configured we open
 * directly in Diff mode, otherwise File. Returns `false` on any git
 * error (best-effort; the UI defaults to File on uncertainty).
 */
export async function isPathChanged(worktreePath: string, relPath: string): Promise<boolean> {
  if (!worktreePath || !relPath) return false
  const proc = spawnSync("git", ["status", "--porcelain", "--", relPath], {
    cwd: worktreePath,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024,
  })
  if (proc.status !== 0) return false
  // Porcelain output: `XY <path>` per line. Empty = clean.
  return (proc.stdout ?? "").trim().length > 0
}

/** Split a unified-diff blob into lines for the renderer. Stable for tests. */
export function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
}
