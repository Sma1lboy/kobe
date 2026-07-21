/**
 * `kobe <path>` — the `code .` gesture: open an existing directory as a
 * standalone `kind:"dir"` task and land in the TUI focused on it.
 *
 * Deliberately NO project association: no saved repo, no main task, no
 * worktree/branch — the task pins the directory itself, and deleting it
 * later only drops the index entry (the directory is never touched).
 * Reopening the same directory reuses (and unarchives) the existing dir
 * task. Prefers a RUNNING daemon (live TUIs see the row immediately);
 * falls back to the in-process orchestrator, persisting focus for the
 * daemon the TUI is about to boot.
 */

import { statSync } from "node:fs"
import { resolve } from "node:path"
import { expandTilde } from "../lib/path-home.ts"

/**
 * True when the first CLI arg is EXPLICIT path syntax (`kobe .`, `kobe ..`,
 * `kobe ./x`, `kobe /abs`, `kobe ~/x`) — the open-directory gesture.
 * Deliberately narrow: a bare word (`kobe statsu`) stays an unknown-command
 * error, never a directory guess.
 */
export function isPathLikeArg(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg === "~" ||
    arg.startsWith("~/")
  )
}

export async function runOpenDirectory(arg: string): Promise<void> {
  const dir = resolve(process.cwd(), expandTilde(arg))
  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    process.stderr.write(`kobe: "${arg}" is not a directory (resolved to ${dir}).\n`)
    process.exit(1)
  }
  const { connectIfRunning } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
  const client = await connectIfRunning()
  try {
    if (client) {
      const { taskId } = await client.request<{ taskId: string }>("task.openDir", { dir })
      await client.request("task.setActive", { taskId })
    } else {
      const { TaskIndexStore } = await import("../orchestrator/index/store.ts")
      const { GitWorktreeManager } = await import("../orchestrator/worktree/manager.ts")
      const { Orchestrator } = await import("../orchestrator/core.ts")
      const store = new TaskIndexStore()
      await store.load()
      const orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
      const task = await orch.openDirectoryTask({ dir })
      const { writeLastActiveTaskId } = await import("../state/last-active.ts")
      writeLastActiveTaskId(String(task.id))
    }
  } finally {
    client?.close()
  }
  const { publishKobeTerminalTitle } = await import("../tui/lib/outer-terminal-title.ts")
  publishKobeTerminalTitle()
  const { startTui } = await import("../tui/index.tsx")
  await startTui()
}
