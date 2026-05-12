/**
 * Open the active task worktree in the user's editor.
 *
 * Inspired by AeroSpace's menu-bar `Open config in '<editor>'` flow:
 * choose an editor dynamically at runtime, show that choice in the UI,
 * and delegate the actual open to the platform instead of hardcoding a
 * single app. kobe's version favours editor CLIs because they can open
 * directories portably; macOS app fallbacks use `open -a`.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, delimiter, isAbsolute, join } from "node:path"

export type WorktreeOpener = {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
}

type DetectDeps = {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
}

type SpawnDeps = {
  readonly spawn?: typeof spawn
}

const CLI_CANDIDATES: ReadonlyArray<{ id: string; label: string; command: string }> = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "code", label: "VS Code", command: "code" },
  { id: "windsurf", label: "Windsurf", command: "windsurf" },
  { id: "zed", label: "Zed", command: "zed" },
]

const MAC_APP_CANDIDATES: ReadonlyArray<{ id: string; label: string; appName: string; paths: readonly string[] }> = [
  {
    id: "cursor.app",
    label: "Cursor",
    appName: "Cursor",
    paths: ["/Applications/Cursor.app", "/System/Applications/Cursor.app"],
  },
  {
    id: "vscode.app",
    label: "VS Code",
    appName: "Visual Studio Code",
    paths: ["/Applications/Visual Studio Code.app"],
  },
  {
    id: "windsurf.app",
    label: "Windsurf",
    appName: "Windsurf",
    paths: ["/Applications/Windsurf.app"],
  },
  {
    id: "zed.app",
    label: "Zed",
    appName: "Zed",
    paths: ["/Applications/Zed.app"],
  },
]

function executableOnPath(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): boolean {
  if (isAbsolute(command)) return exists(command)
  const pathEnv = env.PATH ?? ""
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    if (exists(join(dir, command))) return true
  }
  return false
}

function labelForOverride(command: string): string {
  const name = basename(command)
  if (name === "code") return "VS Code"
  if (name === "cursor") return "Cursor"
  if (name === "windsurf") return "Windsurf"
  if (name === "zed") return "Zed"
  return name || command
}

export function detectWorktreeOpener(deps: DetectDeps = {}): WorktreeOpener | null {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync

  const override = env.KOBE_OPEN_EDITOR?.trim()
  if (override) {
    return { id: "env", label: labelForOverride(override), command: override, args: [] }
  }

  for (const c of CLI_CANDIDATES) {
    if (executableOnPath(c.command, env, exists)) {
      return { id: c.id, label: c.label, command: c.command, args: [] }
    }
  }

  if (platform === "darwin" && executableOnPath("open", env, exists)) {
    for (const app of MAC_APP_CANDIDATES) {
      if (app.paths.some((path) => exists(path))) {
        return { id: app.id, label: app.label, command: "open", args: ["-a", app.appName] }
      }
    }
    return { id: "mac-open", label: "Finder", command: "open", args: [] }
  }

  if (platform === "linux" && executableOnPath("xdg-open", env, exists)) {
    return { id: "xdg-open", label: "Open", command: "xdg-open", args: [] }
  }

  return null
}

export function buildOpenWorktreeCommand(worktreePath: string, opener: WorktreeOpener): [string, string[]] {
  return [opener.command, [...opener.args, worktreePath]]
}

export function openWorktree(worktreePath: string, opener: WorktreeOpener, deps: SpawnDeps = {}): boolean {
  if (!worktreePath) return false
  const spawnFn = deps.spawn ?? spawn
  const [command, args] = buildOpenWorktreeCommand(worktreePath, opener)
  try {
    const child = spawnFn(command, args, { detached: true, stdio: "ignore" })
    if (child.pid === undefined) return false
    child.unref()
    return true
  } catch {
    return false
  }
}
