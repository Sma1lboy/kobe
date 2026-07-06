import { remoteKeyForRepo } from "@/exec/resolve"
import type { EngineLaunchInit } from "@/state/repo-init"
import { killSession, runTmuxCapturing, sessionExists, setSessionOption } from "@/tmux/client"
import { type ObservedSession, decideSessionAction } from "@/tmux/session-decision"
import { healWorkspaceLayout, relaunchEngineInAllWindows } from "./pane-heal"
import { createSession } from "./tmux-session-create.ts"

export interface EnsureSessionOpts {
  readonly name: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly opsCommand?: string
  readonly taskId?: string
  readonly vendor?: string
  readonly repo?: string
  readonly launchInit?: EngineLaunchInit
  readonly archived?: boolean
  readonly archivedWorktree?: string
  readonly preview?: boolean
  readonly title?: string
}

const ensureSessionLocks = new Map<string, Promise<boolean>>()

export async function ensureSession(opts: EnsureSessionOpts): Promise<boolean> {
  const inflight = ensureSessionLocks.get(opts.name)
  if (inflight) return inflight
  const work = ensureSessionImpl(opts)
  ensureSessionLocks.set(opts.name, work)
  try {
    return await work
  } finally {
    ensureSessionLocks.delete(opts.name)
  }
}

const OBSERVE_SESSION_FORMAT = "#{window_id}\t#{window_active}\t#{@kobe_role}\t#{@kobe_worktree}\t#{@kobe_vendor}"

export function parseObservedSession(stdout: string): ObservedSession {
  let worktree = ""
  let vendor = ""
  let claudePaneAlive = false
  const windows = new Set<string>()
  for (const line of stdout.split("\n")) {
    const [windowId, active, role, wt, vd] = line.split("\t")
    if (!windowId?.trim()) continue
    windows.add(windowId.trim())
    if (!worktree && wt?.trim()) worktree = wt.trim()
    if (!vendor && vd?.trim()) vendor = vd.trim()
    if (active?.trim() === "1" && role?.trim() === "claude") claudePaneAlive = true
  }
  return { worktree, vendor, claudePaneAlive, windowCount: windows.size }
}

async function observeSession(name: string): Promise<ObservedSession | null> {
  if (!(await sessionExists(name))) return null
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${name}`, "-F", OBSERVE_SESSION_FORMAT])
  if (code !== 0) return { worktree: "", vendor: "", claudePaneAlive: false, windowCount: 0 }
  return parseObservedSession(stdout)
}

export async function observeSessionVendor(name: string): Promise<string | null> {
  const observed = await observeSession(name)
  const v = observed?.vendor.trim()
  return v ? v : null
}

async function ensureSessionImpl(opts: EnsureSessionOpts): Promise<boolean> {
  const observed = await observeSession(opts.name)
  const action = decideSessionAction(observed, {
    cwd: opts.cwd,
    vendor: opts.vendor,
    hasEngineCommand: opts.command.length > 0,
  })
  const remoteKey = remoteKeyForRepo(opts.repo)

  if (action.kind === "reuse") {
    await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
    return true
  }

  if (action.kind === "respawn-engine") {
    const relaunch = await relaunchEngineInAllWindows(opts.name, opts.cwd, opts.command, remoteKey, opts.vendor)
    if (relaunch === "switched") {
      if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)
      await healWorkspaceLayout(opts.name, {
        cwd: opts.cwd,
        taskId: opts.taskId,
        vendor: opts.vendor,
        vendorChanged: true,
      })
      return true
    }
    if (relaunch === "respawn-failed") {
      await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
      return true
    }
  }

  if (action.kind === "rebuild" || action.kind === "respawn-engine") {
    await killSession(opts.name)
  }
  return createSession(opts)
}
