/**
 * Hide/restore/toggle for the three side panes of a ChatTab window — the Ops
 * (file) pane, the Tasks rail, and the shell Terminal pane. Tasks/terminal
 * hide moves the pane to the hidden helper session (layout-tmux.ts) so its
 * process survives; Ops is stateless and is simply killed/recreated.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { localSpawnCwd } from "@/exec/resolve"
import { runTmux, runTmuxCapturing, runTmuxSequence } from "@/tmux/client"
import {
  ENGINE_PANE_ROLE,
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_PANE_ROLE,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  keepAlive,
  opsPaneCommand,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import { CURRENT_VERSION } from "@/version"
import { inheritedEnvPrefix } from "./launch"
import { type LayoutPaneRow, resolveShellPane } from "./layout-plan"
import {
  cleanupHiddenPaneSessionIfEmpty,
  clearActiveWindowOption,
  displayMessage,
  ensureHiddenPaneSession,
  nextHiddenWindowIndex,
  paneExists,
  preferredOpsHeightPercent,
  preferredRightColumnWidthPercent,
  preferredTasksWidth,
  preferredTerminalHeightPercent,
  sessionWorktree,
  setActiveWindowOption,
  windowOption,
  windowPanes,
} from "./layout-tmux"
import { PANE_VERSION_OPTION } from "./pane-heal-plan"

// ---------------------------------------------------------------------------
// Ops (file) pane
// ---------------------------------------------------------------------------

function opsPaneLaunchCommand(args: {
  readonly cwd: string
  readonly taskId?: string
  readonly vendor?: string
  readonly enginePaneId: string
}): string {
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  return keepAlive(
    envPrefix +
      opsPaneCommand({
        cwd: args.cwd,
        taskId: args.taskId,
        claudePaneId: args.enginePaneId,
        cliInvocation: inv,
        vendor: args.vendor,
      }),
  )
}

export async function toggleOpsPane(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  if (ops) {
    await runTmux(["kill-pane", "-t", ops.paneId])
    return
  }

  const shell = resolveShellPane(rows)
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!engine) {
    await displayMessage(windowId, "kobe: cannot restore file pane in this layout")
    return
  }
  const { cwd, taskId, vendor } = await sessionWorktree(session)
  const opsCmd = opsPaneLaunchCommand({ cwd, taskId, vendor, enginePaneId: engine.paneId })
  const splitArgs = shell
    ? [
        "split-window",
        "-v",
        "-b",
        "-t",
        shell.paneId,
        "-l",
        `${await preferredOpsHeightPercent()}%`,
        "-c",
        localSpawnCwd(cwd),
        "-P",
        "-F",
        "#{pane_id}",
        opsCmd,
      ]
    : [
        "split-window",
        "-h",
        "-t",
        engine.paneId,
        "-l",
        `${await preferredRightColumnWidthPercent()}%`,
        "-c",
        localSpawnCwd(cwd),
        "-P",
        "-F",
        "#{pane_id}",
        opsCmd,
      ]
  const { code, stdout } = await runTmuxCapturing(splitArgs)
  const paneId = stdout.trim()
  if (code !== 0 || !paneId) return
  const commands: (readonly string[])[] = [
    ["set-option", "-p", "-t", paneId, "@kobe_role", OPS_PANE_ROLE],
    ["set-option", "-p", "-t", paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
  ]
  if (shell?.role === "") commands.push(["set-option", "-p", "-t", shell.paneId, "@kobe_role", SHELL_PANE_ROLE])
  await runTmuxSequence(commands)
}

// ---------------------------------------------------------------------------
// Tasks rail
// ---------------------------------------------------------------------------

async function tasksPaneLaunchCommand(session: string): Promise<{ readonly cwd: string; readonly command: string }> {
  const { cwd, taskId } = await sessionWorktree(session)
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  return {
    cwd,
    command: keepAlive(envPrefix + tasksPaneCommand(inv, { initialTaskId: taskId })),
  }
}

function restoreTasksTarget(rows: readonly LayoutPaneRow[]): LayoutPaneRow | undefined {
  return rows.find((row) => row.role === ENGINE_PANE_ROLE) ?? rows[0]
}

async function createTasksPane(session: string, windowId: string, rows: readonly LayoutPaneRow[]): Promise<boolean> {
  const target = restoreTasksTarget(rows)
  if (!target) {
    await displayMessage(windowId, "kobe: cannot restore Tasks pane in this layout")
    return false
  }
  const width = await preferredTasksWidth()
  const { cwd, command } = await tasksPaneLaunchCommand(session)
  const { code, stdout } = await runTmuxCapturing([
    "split-window",
    "-h",
    "-b",
    "-t",
    target.paneId,
    "-l",
    `${width}`,
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    command,
  ])
  const paneId = stdout.trim()
  if (code !== 0 || !paneId) return false
  await runTmuxSequence([
    ["set-option", "-p", "-t", paneId, "@kobe_role", TASKS_PANE_ROLE],
    ["set-option", "-p", "-t", paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
    ["select-pane", "-t", paneId],
  ])
  await clearActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
  await displayMessage(windowId, "kobe: Tasks pane restored")
  return true
}

export async function hideTasksPane(session: string, windowId: string, tasks: LayoutPaneRow): Promise<void> {
  const hidden = await ensureHiddenPaneSession(session)
  const hiddenIndex = await nextHiddenWindowIndex(hidden, windowId)
  const { code, stdout } = await runTmuxCapturing([
    "break-pane",
    "-d",
    "-s",
    tasks.paneId,
    "-t",
    `${hidden}:${hiddenIndex}`,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  const hiddenPane = stdout.trim() || tasks.paneId
  if (code !== 0 || !hiddenPane) {
    await displayMessage(windowId, "kobe: could not hide Tasks pane")
    return
  }
  await setActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION, hiddenPane)
  await displayMessage(windowId, "kobe: Tasks pane hidden")
}

export async function restoreHiddenTasksPane(session: string, windowId: string, hiddenPane: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  if (!(await paneExists(hiddenPane))) {
    await clearActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
    const visibleTasks = rows.find((row) => row.role === TASKS_PANE_ROLE)
    if (visibleTasks) {
      await runTmux(["select-pane", "-t", visibleTasks.paneId])
      return
    }
    await createTasksPane(session, windowId, rows)
    return
  }

  const target = restoreTasksTarget(rows)
  if (!target) {
    await displayMessage(windowId, "kobe: cannot restore Tasks pane in this layout")
    return
  }
  const code = await runTmux([
    "join-pane",
    "-h",
    "-b",
    "-s",
    hiddenPane,
    "-t",
    target.paneId,
    "-l",
    `${await preferredTasksWidth()}`,
  ])
  if (code !== 0) {
    await displayMessage(windowId, "kobe: could not restore Tasks pane")
    return
  }
  await runTmuxSequence([
    ["set-option", "-p", "-t", hiddenPane, "@kobe_role", TASKS_PANE_ROLE],
    ["set-option", "-p", "-t", hiddenPane, PANE_VERSION_OPTION, CURRENT_VERSION],
    ["select-pane", "-t", hiddenPane],
  ])
  await clearActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
  await cleanupHiddenPaneSessionIfEmpty(session)
  await displayMessage(windowId, "kobe: Tasks pane restored")
}

export async function toggleTasksPane(session: string, windowId: string): Promise<void> {
  const hiddenPane = await windowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
  if (hiddenPane) {
    await restoreHiddenTasksPane(session, windowId, hiddenPane)
    return
  }

  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const tasks = rows.find((row) => row.role === TASKS_PANE_ROLE)
  if (tasks) {
    await hideTasksPane(session, windowId, tasks)
    return
  }
  await createTasksPane(session, windowId, rows)
}

export async function restoreTasksPane(session: string, windowId: string): Promise<void> {
  const hiddenPane = await windowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
  if (hiddenPane) {
    await restoreHiddenTasksPane(session, windowId, hiddenPane)
    return
  }

  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const tasks = rows.find((row) => row.role === TASKS_PANE_ROLE)
  if (tasks) {
    await runTmux(["select-pane", "-t", tasks.paneId])
    return
  }
  await createTasksPane(session, windowId, rows)
}

// ---------------------------------------------------------------------------
// Shell terminal pane
// ---------------------------------------------------------------------------

export async function hideTerminalPane(session: string, windowId: string, shell: LayoutPaneRow): Promise<void> {
  if (shell.role === "") {
    await runTmux(["set-option", "-p", "-t", shell.paneId, "@kobe_role", SHELL_PANE_ROLE])
  }
  const hidden = await ensureHiddenPaneSession(session)
  const hiddenIndex = await nextHiddenWindowIndex(hidden, windowId)
  const { code, stdout } = await runTmuxCapturing([
    "break-pane",
    "-d",
    "-s",
    shell.paneId,
    "-t",
    `${hidden}:${hiddenIndex}`,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  const hiddenPane = stdout.trim() || shell.paneId
  if (code !== 0 || !hiddenPane) {
    await displayMessage(windowId, "kobe: could not hide terminal pane")
    return
  }
  await setActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION, hiddenPane)
  await displayMessage(windowId, "kobe: Terminal pane hidden")
}

async function createTerminalPane(session: string, windowId: string, rows: readonly LayoutPaneRow[]): Promise<boolean> {
  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!ops && !engine) {
    await displayMessage(windowId, "kobe: cannot restore terminal pane in this layout")
    return false
  }
  const { cwd } = await sessionWorktree(session)
  const splitArgs = ops
    ? [
        "split-window",
        "-v",
        "-t",
        ops.paneId,
        "-l",
        `${await preferredTerminalHeightPercent()}%`,
        "-c",
        localSpawnCwd(cwd),
        "-P",
        "-F",
        "#{pane_id}",
      ]
    : [
        "split-window",
        "-h",
        "-t",
        engine?.paneId ?? "",
        "-l",
        `${await preferredRightColumnWidthPercent()}%`,
        "-c",
        localSpawnCwd(cwd),
        "-P",
        "-F",
        "#{pane_id}",
      ]
  const { code, stdout } = await runTmuxCapturing(splitArgs)
  const paneId = stdout.trim()
  if (code !== 0 || !paneId) return false
  await runTmux(["set-option", "-p", "-t", paneId, "@kobe_role", SHELL_PANE_ROLE])
  await clearActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
  await displayMessage(windowId, "kobe: Terminal pane restored")
  return true
}

export async function restoreHiddenTerminalPane(session: string, windowId: string, hiddenPane: string): Promise<void> {
  let rows = await windowPanes(session, windowId)
  if (!rows) return
  if (!(await paneExists(hiddenPane))) {
    await clearActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
    await createTerminalPane(session, windowId, rows)
    return
  }

  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!ops && !engine) {
    await displayMessage(windowId, "kobe: cannot restore terminal pane in this layout")
    return
  }
  const joinArgs = ops
    ? ["join-pane", "-v", "-s", hiddenPane, "-t", ops.paneId, "-l", `${await preferredTerminalHeightPercent()}%`]
    : [
        "join-pane",
        "-h",
        "-s",
        hiddenPane,
        "-t",
        engine?.paneId ?? "",
        "-l",
        `${await preferredRightColumnWidthPercent()}%`,
      ]
  const code = await runTmux(joinArgs)
  if (code !== 0) {
    await displayMessage(windowId, "kobe: could not restore terminal pane")
    return
  }
  await runTmux(["set-option", "-p", "-t", hiddenPane, "@kobe_role", SHELL_PANE_ROLE])
  await clearActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
  await cleanupHiddenPaneSessionIfEmpty(session)
  rows = await windowPanes(session, windowId)
  const restored = rows?.find((row) => row.paneId === hiddenPane)
  if (restored) await runTmux(["select-pane", "-t", restored.paneId])
  await displayMessage(windowId, "kobe: Terminal pane restored")
}

export async function toggleTerminalPane(session: string, windowId: string): Promise<void> {
  const hiddenPane = await windowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
  if (hiddenPane) {
    await restoreHiddenTerminalPane(session, windowId, hiddenPane)
    return
  }

  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const shell = resolveShellPane(rows)
  if (shell) {
    await hideTerminalPane(session, windowId, shell)
    return
  }
  await createTerminalPane(session, windowId, rows)
}
