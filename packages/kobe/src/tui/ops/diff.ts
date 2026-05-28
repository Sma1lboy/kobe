/**
 * Thin wrappers around `git diff` and file reads for the preview pane.
 *
 * Symmetric with `src/orchestrator/worktree/git.ts` (Stream B): we use
 * async process/file APIs. The preview pane lives in the TUI process,
 * so sync `git` / `cat` calls make typing and rendering freeze when a
 * large worktree or cold disk makes those calls slow.
 *
 * We never invoke a shell. Every arg goes through the array form, with
 * `shell: false` made explicit. `cwd` is required on every call; we
 * never inherit `process.cwd()`.
 *
 * `readDiff` returns the raw unified-diff text (the same format the
 * lifted `DiffLine` renderer consumes). Git failures are returned as
 * data so the UI can render a short, actionable error.
 *
 * `readFile` reads at most `MAX_BYTES + 1` bytes directly through
 * `fs.promises.open`, so a huge file never gets loaded wholesale just
 * because the user highlighted it in the tree.
 */

import { spawn } from "node:child_process"
import { open, stat } from "node:fs/promises"
import path from "node:path"

/**
 * Cap any one read at 2 MiB. Beyond that the user almost certainly
 * doesn't want to render in the TUI; we truncate and append a banner.
 * Matches the buffer cap behavior tests expect.
 */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * Resolve `cwd` to the git toplevel that owns it, falling back to `cwd`
 * itself if it isn't inside a git repo.
 *
 * Why: FileTree's `git ls-files --full-name` and `git status --porcelain`
 * emit paths relative to the **repo toplevel**, not the cwd. For
 * worktree tasks that's the same path (`git worktree add` makes the
 * worktree its own toplevel) so no fix-up is needed. But for "main"
 * tasks (KOB-15) pointing at a *subdirectory* of a monorepo, cwd is
 * `packages/kobe` while the toplevel is `/Users/.../kobe`. If `cat` /
 * `git diff` use the subdir as cwd, `.agents/skills/linear/SKILL.md`
 * (a toplevel-relative path emitted by FileTree) resolves to
 * `packages/kobe/.agents/...` and ENOENTs — surfaces in the UI as
 * "file not found (rebased away?)". Resolving to the toplevel here
 * keeps FileTree and Preview using the same path frame.
 */
async function resolveGitToplevel(cwd: string): Promise<string> {
  const r = await runProcess("git", ["rev-parse", "--show-toplevel"], cwd, 64 * 1024)
  if (r.status !== 0) return cwd
  const top = r.stdout.trim()
  return top || cwd
}

/** Banner appended when output exceeds {@link MAX_BYTES}. */
const TRUNCATED_BANNER = "\n... [truncated by kobe — file exceeds 2 MiB] ..."

export type ReadResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string }

type ProcessResult = {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  truncated: boolean
}

function runProcess(command: string, args: readonly string[], cwd: string, maxBytes: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false

    function pushBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number): number {
      const remaining = Math.max(0, maxBytes + 1 - currentBytes)
      if (remaining <= 0) {
        truncated = true
        return currentBytes + chunk.length
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        truncated = true
      } else {
        chunks.push(chunk)
      }
      return currentBytes + chunk.length
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = pushBounded(stdoutChunks, chunk, stdoutBytes)
      if (stdoutBytes > maxBytes) child.kill("SIGTERM")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = pushBounded(stderrChunks, chunk, stderrBytes)
    })
    child.on("error", reject)
    child.on("close", (status, signal) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        status,
        signal,
        truncated,
      })
    })
  })
}

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
  const top = await resolveGitToplevel(worktreePath)
  const absPath = path.join(top, relPath)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(absPath, "r")
    const buf = Buffer.allocUnsafe(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buf, 0, MAX_BYTES + 1, 0)
    const truncated = bytesRead > MAX_BYTES
    const raw = buf.subarray(0, Math.min(bytesRead, MAX_BYTES)).toString("utf8")
    return { ok: true, text: truncated ? raw + TRUNCATED_BANNER : raw, truncated }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  } finally {
    await handle?.close().catch(() => {})
  }
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
  const proc = await runProcess(
    "git",
    ["diff", "--no-color", base, "--", relPath],
    await resolveGitToplevel(worktreePath),
    MAX_BYTES,
  )
  // `git diff` returns 0 on success (with or without changes). Non-zero
  // = real failure (bad ref, etc.). Don't let the user wonder why an
  // empty pane appeared.
  if (!proc.truncated && proc.status !== 0) {
    const err = (proc.stderr ?? "").trim() || `git diff exited ${proc.status ?? proc.signal ?? "unknown"}`
    return { ok: false, error: err }
  }
  const raw = proc.stdout
  return {
    ok: true,
    text: proc.truncated ? raw.slice(0, MAX_BYTES) + TRUNCATED_BANNER : raw,
    truncated: proc.truncated,
  }
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
  const proc = await runProcess(
    "git",
    ["status", "--porcelain", "--", relPath],
    await resolveGitToplevel(worktreePath),
    64 * 1024,
  )
  if (proc.status !== 0) return false
  // Porcelain output: `XY <path>` per line. Empty = clean.
  return (proc.stdout ?? "").trim().length > 0
}

/** Split a unified-diff blob into lines for the renderer. Stable for tests. */
export function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
}

export type StatResult =
  | { readonly ok: true; readonly size: number; readonly mtime: Date; readonly absPath: string }
  | { readonly ok: false; readonly error: string }

/**
 * Stat a worktree-relative path. Returns size, mtime and the resolved
 * absolute path so the media card has everything it needs in one call.
 * Uses the same toplevel-walk-up as {@link readFile} so toplevel-relative
 * paths emitted by FileTree resolve correctly from a subdir worktreePath
 * (KOB-19).
 */
export async function statFile(worktreePath: string, relPath: string): Promise<StatResult> {
  if (!worktreePath) return { ok: false, error: "no worktree path" }
  if (!relPath) return { ok: false, error: "no file path" }
  if (relPath.split("/").includes("..")) {
    return { ok: false, error: "path escapes worktree" }
  }
  const top = await resolveGitToplevel(worktreePath)
  const absPath = path.join(top, relPath)
  try {
    const s = await stat(absPath)
    return { ok: true, size: s.size, mtime: s.mtime, absPath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

export type HeaderResult = { readonly ok: true; readonly buf: Buffer } | { readonly ok: false; readonly error: string }

/**
 * Read up to `bytes` bytes from the start of a worktree-relative path.
 * Used by the media pane for image-header parsing — we only need the
 * first ~32 KiB to extract dimensions, so reading wholesale through
 * {@link readFile} (which materializes up to 2 MiB and converts to
 * utf-8) would be wasteful for large images.
 */
export async function readHeaderBytes(worktreePath: string, relPath: string, bytes: number): Promise<HeaderResult> {
  if (!worktreePath) return { ok: false, error: "no worktree path" }
  if (!relPath) return { ok: false, error: "no file path" }
  if (relPath.split("/").includes("..")) {
    return { ok: false, error: "path escapes worktree" }
  }
  if (bytes <= 0) return { ok: true, buf: Buffer.alloc(0) }
  const top = await resolveGitToplevel(worktreePath)
  const absPath = path.join(top, relPath)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(absPath, "r")
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return { ok: true, buf: buf.subarray(0, bytesRead) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  } finally {
    await handle?.close().catch(() => {})
  }
}
