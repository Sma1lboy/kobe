/**
 * Shared tmux plumbing for the layout action modules — window/pane queries,
 * window-option storage, the hidden helper session that parks broken-out
 * panes, and the user-preferred geometry readers. Everything here shells out
 * through `@/tmux/client`; the pure policy lives in layout-plan.ts.
 */

import { localSpawnCwd } from "@/exec/resolve"
import { getSessionOptions, readLayoutGeometry, runTmux, runTmuxCapturing, sessionExists } from "@/tmux/client"
import {
  ENGINE_PANE_ROLE,
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  hiddenTerminalSessionName,
  hiddenTerminalWindowIndex,
} from "@/tmux/session-layout"
import {
  ACTIVE_WINDOW_LAYOUT_FORMAT,
  type LayoutPaneRow,
  expandedTerminalHeightPercent,
  parseLayoutPaneRows,
} from "./layout-plan"

export async function windowPanes(session: string, windowId?: string): Promise<LayoutPaneRow[] | null> {
  const target = windowId?.trim() || `=${session}`
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-t", target, "-F", ACTIVE_WINDOW_LAYOUT_FORMAT])
  return code === 0 ? parseLayoutPaneRows(stdout) : null
}

export async function activeWindowId(session: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    "#{window_active}\t#{window_id}",
  ])
  if (code !== 0) return ""
  for (const line of stdout.split("\n")) {
    const [active, windowId] = line.split("\t")
    if (active?.trim() === "1" && windowId?.trim()) return windowId.trim()
  }
  return ""
}

export async function resolveActionWindowId(session: string, windowId?: string): Promise<string> {
  return windowId?.trim() || (await activeWindowId(session))
}

export async function windowOption(target: string, option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-wqv", "-t", target, option])
  return code === 0 ? stdout.trim() : ""
}

export async function setActiveWindowOption(windowId: string, option: string, value: string): Promise<void> {
  await runTmux(["set-window-option", "-t", windowId, option, value])
}

export async function clearActiveWindowOption(windowId: string, option: string): Promise<void> {
  await runTmux(["set-window-option", "-u", "-t", windowId, option])
}

export async function paneExists(paneId: string): Promise<boolean> {
  const { code, stdout } = await runTmuxCapturing(["display-message", "-p", "-t", paneId, "#{pane_id}"])
  return code === 0 && stdout.trim() === paneId
}

export async function displayMessage(target: string, message: string): Promise<void> {
  await runTmux(["display-message", "-t", target, message])
}

export async function sessionWorktree(session: string): Promise<{ cwd: string; taskId?: string; vendor?: string }> {
  const opts = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  return {
    cwd: opts["@kobe_worktree"] || process.cwd(),
    taskId: opts["@kobe_task"] || undefined,
    vendor: opts["@kobe_vendor"] || undefined,
  }
}

/** Window ids of the session, in tmux order. */
export async function sessionWindowIds(session: string): Promise<string[]> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
  if (code !== 0) return []
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** A window is an engine ChatTab (not a Settings/help/new-task surface) iff it has an engine pane. */
export async function windowHasEnginePane(session: string, windowId: string): Promise<boolean> {
  const rows = await windowPanes(session, windowId)
  return !!rows?.some((row) => row.role === ENGINE_PANE_ROLE)
}

export async function activeSessionWindowCount(session: string): Promise<number> {
  return (await sessionWindowIds(session)).length
}

// ---------------------------------------------------------------------------
// Hidden helper session — parks Tasks/Terminal panes broken out of a window so
// their processes survive while the visible window reclaims the space.
// ---------------------------------------------------------------------------

async function hiddenWindowIndices(hiddenSession: string): Promise<Set<number>> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${hiddenSession}`, "-F", "#{window_index}"])
  if (code !== 0) return new Set()
  return new Set(
    stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  )
}

export async function nextHiddenWindowIndex(hiddenSession: string, windowId: string): Promise<number> {
  const used = await hiddenWindowIndices(hiddenSession)
  let idx = hiddenTerminalWindowIndex(windowId)
  while (used.has(idx)) idx++
  return idx
}

export async function ensureHiddenPaneSession(session: string): Promise<string> {
  const hidden = hiddenTerminalSessionName(session)
  if (await sessionExists(hidden)) return hidden
  await runTmux([
    "new-session",
    "-d",
    "-s",
    hidden,
    "-n",
    "hidden-panes",
    "-c",
    localSpawnCwd(process.cwd()),
    "while :; do sleep 3600; done",
  ])
  return hidden
}

export async function cleanupHiddenPaneSessionIfEmpty(session: string): Promise<void> {
  const hidden = hiddenTerminalSessionName(session)
  if (!(await sessionExists(hidden))) return
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${hidden}`, "-F", "#{@kobe_role}"])
  if (code !== 0) return
  const hasHiddenPane = stdout.split("\n").some((line) => {
    const role = line.trim()
    return role === SHELL_PANE_ROLE || role === TASKS_PANE_ROLE
  })
  if (!hasHiddenPane) await runTmux(["kill-session", "-t", `=${hidden}`])
}

async function cleanupHiddenPaneForWindow(windowId: string, option: string): Promise<void> {
  const hiddenPane = await windowOption(windowId, option)
  if (!hiddenPane) return
  if (await paneExists(hiddenPane)) {
    await runTmux(["kill-pane", "-t", hiddenPane])
  }
  await clearActiveWindowOption(windowId, option)
}

export async function cleanupHiddenPanesForWindow(session: string, windowId: string): Promise<void> {
  await cleanupHiddenPaneForWindow(windowId, HIDDEN_TERMINAL_PANE_OPTION)
  await cleanupHiddenPaneForWindow(windowId, HIDDEN_TASKS_PANE_OPTION)
  await cleanupHiddenPaneSessionIfEmpty(session)
}

// ---------------------------------------------------------------------------
// User-preferred geometry (persisted layout settings).
// ---------------------------------------------------------------------------

export async function preferredTasksWidth(): Promise<number> {
  return (await readLayoutGeometry()).tasksWidth
}

export async function preferredOpsHeightPercent(): Promise<number> {
  return (await readLayoutGeometry()).opsHeightPct
}

export async function preferredRightColumnWidthPercent(): Promise<number> {
  return (await readLayoutGeometry()).rightColumnWidthPct
}

export async function preferredTerminalHeightPercent(): Promise<number> {
  return expandedTerminalHeightPercent((await readLayoutGeometry()).opsHeightPct)
}
