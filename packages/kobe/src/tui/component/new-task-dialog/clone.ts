/**
 * Clone-tab helpers for the new-task dialog — URL parsing, folder
 * naming, target validation, and the async `git clone` spawn.
 *
 * Split out of `./state.ts`: these touch the filesystem (collision
 * checks against the parent dir) and spawn a subprocess, so they don't
 * belong in the pure state machine. The clone itself is **async**
 * (`spawn`, never `spawnSync`) — a clone is network-bound and can run
 * for minutes, so a sync spawn would freeze the opentui renderer; the
 * dialog stays responsive and streams git's stderr progress instead.
 *
 * Used only by `./dialog.tsx`'s "For New Repo" tab.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Readable } from "node:stream"
import { t } from "@/tui/i18n"
import { expandHome } from "../../lib/path-helpers"

type EventedCloneProcess = {
  readonly stderr: Readable | null
  on(event: "error", listener: (err: Error) => void): void
  on(event: "close", listener: (code: number | null) => void): void
}

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
  if (!trimmed) return t("newTask.error.gitUrlRequired")
  // Must contain either `://` (https / ssh / git) or `:` (SCP-form), or
  // be a local path. Refuse only completely formless single-token input.
  const hasProtocol = trimmed.includes("://")
  const hasScpSep = trimmed.includes("@") && trimmed.includes(":")
  const hasPathSep = trimmed.includes("/")
  if (!hasProtocol && !hasScpSep && !hasPathSep) {
    return t("newTask.error.gitUrlInvalid", { url: trimmed })
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
  if (!folderTrimmed) return t("newTask.error.folderRequired")
  if (folderTrimmed.includes("/") || folderTrimmed.includes("\\")) {
    return t("newTask.error.folderHasSeparator")
  }
  const parentTrimmed = parentDir.trim()
  if (!parentTrimmed) return t("newTask.error.parentRequired")
  const parentExpanded = expandHome(parentTrimmed)
  let parentStat: fs.Stats
  try {
    parentStat = fs.statSync(parentExpanded)
  } catch {
    return t("newTask.error.parentNotFound", { path: parentExpanded })
  }
  if (!parentStat.isDirectory()) return t("newTask.error.parentNotDir", { path: parentExpanded })
  const target = path.join(parentExpanded, folderTrimmed)
  if (fs.existsSync(target)) return t("newTask.error.targetExists", { path: target })
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
