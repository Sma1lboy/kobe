/**
 * User-facing tmux layout controls for the direct handover workspace.
 *
 * These actions are intentionally tmux-local. Middle workspace splits are
 * temporary panes inside the current ChatTab window: they do not touch the task
 * index, do not become a default for future ChatTabs, and disappear when the
 * tmux window/session is rebuilt. Tasks/terminal hide controls move panes to a
 * hidden helper session and join them back, so their processes survive while
 * the visible window gets the space back.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { localSpawnCwd } from "@/exec/resolve"
import {
  getServerOptions,
  getSessionOptions,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
} from "@/tmux/client"
import {
  CLAUDE_PANE_PERCENT,
  ENGINE_PANE_ROLE,
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_HEIGHT_OPTION,
  OPS_PANE_PERCENT,
  OPS_PANE_ROLE,
  RIGHT_COLUMN_WIDTH_OPTION,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  TASKS_PANE_WIDTH,
  TASKS_WIDTH_OPTION,
  WORKSPACE_AUX_PANE_ROLE,
  WORKSPACE_SPLIT_MAX_PANES,
  clampPanePercent,
  clampTasksPaneWidth,
  hiddenTerminalSessionName,
  hiddenTerminalWindowIndex,
  keepAlive,
  opsPaneCommand,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import { CURRENT_VERSION } from "@/version"
import { inheritedEnvPrefix } from "./launch"
import { PANE_VERSION_OPTION } from "./pane-heal"

export type LayoutAction =
  | "workspace-split"
  | "workspace-close"
  | "workspace-reset"
  | "tasks-toggle"
  | "tasks-restore"
  | "ops-toggle"
  | "terminal-toggle"
  | "chat-tab-close"

export type LayoutPaneRow = {
  readonly paneId: string
  readonly role: string
  readonly active: boolean
  readonly paneWidth: number
  readonly paneHeight: number
  readonly windowWidth: number
  readonly windowHeight: number
}

const ACTIVE_WINDOW_LAYOUT_FORMAT =
  "#{pane_id}\t#{@kobe_role}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}"

export function parseLayoutPaneRows(stdout: string): LayoutPaneRow[] {
  const rows: LayoutPaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [paneId, role, active, paneWidth, paneHeight, windowWidth, windowHeight] = line.split("\t")
    if (!paneId) continue
    const width = Number.parseInt(paneWidth ?? "", 10)
    const height = Number.parseInt(paneHeight ?? "", 10)
    const winW = Number.parseInt(windowWidth ?? "", 10)
    const winH = Number.parseInt(windowHeight ?? "", 10)
    rows.push({
      paneId: paneId.trim(),
      role: role?.trim() ?? "",
      active: active?.trim() === "1",
      paneWidth: Number.isFinite(width) ? width : 0,
      paneHeight: Number.isFinite(height) ? height : 0,
      windowWidth: Number.isFinite(winW) ? winW : 0,
      windowHeight: Number.isFinite(winH) ? winH : 0,
    })
  }
  return rows
}

export type WorkspaceSplitPlan =
  | { readonly kind: "split"; readonly targetPane: string; readonly direction: "-h" | "-v" }
  | { readonly kind: "maxed" }
  | { readonly kind: "missing-engine" }

/**
 * Natural templates for 1→4 middle panes:
 *   2 panes: split engine horizontally.
 *   3 panes: split the first aux vertically, creating a right-side stack.
 *   4 panes: split engine vertically, yielding a 2x2 grid.
 */
export function planWorkspaceSplit(rows: readonly LayoutPaneRow[]): WorkspaceSplitPlan {
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!engine) return { kind: "missing-engine" }
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length + 1 >= WORKSPACE_SPLIT_MAX_PANES) return { kind: "maxed" }
  if (aux.length === 0) return { kind: "split", targetPane: engine.paneId, direction: "-h" }
  if (aux.length === 1) return { kind: "split", targetPane: aux[0]?.paneId ?? engine.paneId, direction: "-v" }
  return { kind: "split", targetPane: engine.paneId, direction: "-v" }
}

export function resolveShellPane(rows: readonly LayoutPaneRow[]): LayoutPaneRow | undefined {
  return rows.find((row) => row.role === SHELL_PANE_ROLE) ?? rows.find((row) => row.role === "")
}

export function expandedTerminalHeightPercent(rawOpsHeightPercent?: number): number {
  const opsPct = clampPanePercent(rawOpsHeightPercent ?? Number.NaN) ?? OPS_PANE_PERCENT
  return 100 - opsPct
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function windowPanes(session: string, windowId?: string): Promise<LayoutPaneRow[] | null> {
  const target = windowId?.trim() || `=${session}`
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-t", target, "-F", ACTIVE_WINDOW_LAYOUT_FORMAT])
  return code === 0 ? parseLayoutPaneRows(stdout) : null
}

async function activeWindowId(session: string): Promise<string> {
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

async function windowOption(target: string, option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-wqv", "-t", target, option])
  return code === 0 ? stdout.trim() : ""
}

async function setActiveWindowOption(windowId: string, option: string, value: string): Promise<void> {
  await runTmux(["set-window-option", "-t", windowId, option, value])
}

async function clearActiveWindowOption(windowId: string, option: string): Promise<void> {
  await runTmux(["set-window-option", "-u", "-t", windowId, option])
}

async function paneExists(paneId: string): Promise<boolean> {
  const { code, stdout } = await runTmuxCapturing(["display-message", "-p", "-t", paneId, "#{pane_id}"])
  return code === 0 && stdout.trim() === paneId
}

async function display(session: string, message: string): Promise<void> {
  await runTmux(["display-message", "-t", session, message])
}

async function sessionWorktree(session: string): Promise<{ cwd: string; taskId?: string; vendor?: string }> {
  const opts = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  return {
    cwd: opts["@kobe_worktree"] || process.cwd(),
    taskId: opts["@kobe_task"] || undefined,
    vendor: opts["@kobe_vendor"] || undefined,
  }
}

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

async function resolveActionWindowId(session: string, windowId?: string): Promise<string> {
  return windowId?.trim() || (await activeWindowId(session))
}

async function addWorkspaceSplit(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const plan = planWorkspaceSplit(rows)
  if (plan.kind === "missing-engine") {
    await display(windowId, "kobe: no engine pane in this window")
    return
  }
  if (plan.kind === "maxed") {
    await display(windowId, `kobe: workspace split limit is ${WORKSPACE_SPLIT_MAX_PANES} panes`)
    return
  }

  const { cwd } = await sessionWorktree(session)
  const { code, stdout } = await runTmuxCapturing([
    "split-window",
    plan.direction,
    "-t",
    plan.targetPane,
    "-l",
    "50%",
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive("true"),
  ])
  const paneId = stdout.trim()
  if (code !== 0 || !paneId) return
  await runTmuxSequence([
    ["set-option", "-p", "-t", paneId, "@kobe_role", WORKSPACE_AUX_PANE_ROLE],
    ["select-pane", "-t", paneId],
  ])
}

async function closeWorkspaceSplit(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length === 0) {
    await display(windowId, "kobe: no workspace split to close")
    return
  }
  const activeAux = aux.find((row) => row.active)
  const target = activeAux ?? aux[aux.length - 1]
  if (!target) return
  await runTmux(["kill-pane", "-t", target.paneId])
}

async function resetWorkspaceSplits(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length === 0) {
    await display(windowId, "kobe: no workspace splits to reset")
    return
  }
  await runTmuxSequence(aux.map((row) => ["kill-pane", "-t", row.paneId]))
}

async function preferredTasksWidth(): Promise<number> {
  const opts = await getServerOptions([TASKS_WIDTH_OPTION])
  return clampTasksPaneWidth(parsePositiveInt(opts[TASKS_WIDTH_OPTION]) ?? TASKS_PANE_WIDTH)
}

async function tasksPaneLaunchCommand(session: string): Promise<{ readonly cwd: string; readonly command: string }> {
  const { cwd, taskId } = await sessionWorktree(session)
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  return {
    cwd,
    command: keepAlive(envPrefix + tasksPaneCommand(inv, { initialTaskId: taskId })),
  }
}

async function toggleOpsPane(session: string, windowId: string): Promise<void> {
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
    await display(windowId, "kobe: cannot restore file pane in this layout")
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

async function preferredOpsHeightPercent(): Promise<number> {
  const opts = await getServerOptions([OPS_HEIGHT_OPTION])
  return clampPanePercent(Number.parseInt(opts[OPS_HEIGHT_OPTION] ?? "", 10)) ?? OPS_PANE_PERCENT
}

async function preferredRightColumnWidthPercent(): Promise<number> {
  const opts = await getServerOptions([RIGHT_COLUMN_WIDTH_OPTION])
  return clampPanePercent(Number.parseInt(opts[RIGHT_COLUMN_WIDTH_OPTION] ?? "", 10)) ?? 100 - CLAUDE_PANE_PERCENT
}

async function preferredTerminalHeightPercent(): Promise<number> {
  const opts = await getServerOptions([OPS_HEIGHT_OPTION])
  return expandedTerminalHeightPercent(Number.parseInt(opts[OPS_HEIGHT_OPTION] ?? "", 10))
}

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

async function nextHiddenWindowIndex(hiddenSession: string, windowId: string): Promise<number> {
  const used = await hiddenWindowIndices(hiddenSession)
  let idx = hiddenTerminalWindowIndex(windowId)
  while (used.has(idx)) idx++
  return idx
}

async function ensureHiddenPaneSession(session: string): Promise<string> {
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

async function cleanupHiddenPaneSessionIfEmpty(session: string): Promise<void> {
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

async function cleanupHiddenTerminalForWindow(session: string, windowId: string): Promise<void> {
  await cleanupHiddenPaneForWindow(session, windowId, HIDDEN_TERMINAL_PANE_OPTION)
}

async function cleanupHiddenTasksForWindow(session: string, windowId: string): Promise<void> {
  await cleanupHiddenPaneForWindow(session, windowId, HIDDEN_TASKS_PANE_OPTION)
}

async function cleanupHiddenPaneForWindow(session: string, windowId: string, option: string): Promise<void> {
  const hiddenPane = await windowOption(windowId, option)
  if (!hiddenPane) return
  if (await paneExists(hiddenPane)) {
    await runTmux(["kill-pane", "-t", hiddenPane])
  }
  await clearActiveWindowOption(windowId, option)
}

async function cleanupHiddenPanesForWindow(session: string, windowId: string): Promise<void> {
  await cleanupHiddenTerminalForWindow(session, windowId)
  await cleanupHiddenTasksForWindow(session, windowId)
  await cleanupHiddenPaneSessionIfEmpty(session)
}

function restoreTasksTarget(rows: readonly LayoutPaneRow[]): LayoutPaneRow | undefined {
  return rows.find((row) => row.role === ENGINE_PANE_ROLE) ?? rows[0]
}

async function createTasksPane(session: string, windowId: string, rows: readonly LayoutPaneRow[]): Promise<boolean> {
  const target = restoreTasksTarget(rows)
  if (!target) {
    await display(windowId, "kobe: cannot restore Tasks pane in this layout")
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
  await display(windowId, "kobe: Tasks pane restored")
  return true
}

async function hideTasksPane(session: string, windowId: string, tasks: LayoutPaneRow): Promise<void> {
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
    await display(windowId, "kobe: could not hide Tasks pane")
    return
  }
  await setActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION, hiddenPane)
  await display(windowId, "kobe: Tasks pane hidden")
}

async function restoreHiddenTasksPane(session: string, windowId: string, hiddenPane: string): Promise<void> {
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
    await display(windowId, "kobe: cannot restore Tasks pane in this layout")
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
    await display(windowId, "kobe: could not restore Tasks pane")
    return
  }
  await runTmuxSequence([
    ["set-option", "-p", "-t", hiddenPane, "@kobe_role", TASKS_PANE_ROLE],
    ["set-option", "-p", "-t", hiddenPane, PANE_VERSION_OPTION, CURRENT_VERSION],
    ["select-pane", "-t", hiddenPane],
  ])
  await clearActiveWindowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
  await cleanupHiddenPaneSessionIfEmpty(session)
  await display(windowId, "kobe: Tasks pane restored")
}

async function toggleTasksPane(session: string, windowId: string): Promise<void> {
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

async function restoreTasksPane(session: string, windowId: string): Promise<void> {
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

async function hideTerminalPane(session: string, windowId: string, shell: LayoutPaneRow): Promise<void> {
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
    await display(windowId, "kobe: could not hide terminal pane")
    return
  }
  await setActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION, hiddenPane)
  await display(windowId, "kobe: Terminal pane hidden")
}

async function createTerminalPane(session: string, windowId: string, rows: readonly LayoutPaneRow[]): Promise<boolean> {
  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!ops && !engine) {
    await display(windowId, "kobe: cannot restore terminal pane in this layout")
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
  await display(windowId, "kobe: Terminal pane restored")
  return true
}

async function restoreHiddenTerminalPane(session: string, windowId: string, hiddenPane: string): Promise<void> {
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
    await display(windowId, "kobe: cannot restore terminal pane in this layout")
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
    await display(windowId, "kobe: could not restore terminal pane")
    return
  }
  await runTmux(["set-option", "-p", "-t", hiddenPane, "@kobe_role", SHELL_PANE_ROLE])
  await clearActiveWindowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
  await cleanupHiddenPaneSessionIfEmpty(session)
  rows = await windowPanes(session, windowId)
  const restored = rows?.find((row) => row.paneId === hiddenPane)
  if (restored) await runTmux(["select-pane", "-t", restored.paneId])
  await display(windowId, "kobe: Terminal pane restored")
}

async function toggleTerminalPane(session: string, windowId: string): Promise<void> {
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

async function activeSessionWindowCount(session: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((line) => line.trim().length > 0).length
}

async function closeChatTab(session: string, windowId: string): Promise<void> {
  if ((await activeSessionWindowCount(session)) <= 1) {
    await display(windowId, "Cannot close the only ChatTab")
    return
  }
  await cleanupHiddenPanesForWindow(session, windowId)
  await runTmux(["kill-window", "-t", windowId])
}

export async function runLayoutAction(
  session: string,
  action: LayoutAction,
  opts: { readonly windowId?: string } = {},
): Promise<void> {
  if (!(await sessionExists(session))) return
  const windowId = await resolveActionWindowId(session, opts.windowId)
  if (!windowId) return
  switch (action) {
    case "workspace-split":
      await addWorkspaceSplit(session, windowId)
      return
    case "workspace-close":
      await closeWorkspaceSplit(session, windowId)
      return
    case "workspace-reset":
      await resetWorkspaceSplits(session, windowId)
      return
    case "tasks-toggle":
      await toggleTasksPane(session, windowId)
      return
    case "tasks-restore":
      await restoreTasksPane(session, windowId)
      return
    case "ops-toggle":
      await toggleOpsPane(session, windowId)
      return
    case "terminal-toggle":
      await toggleTerminalPane(session, windowId)
      return
    case "chat-tab-close":
      await closeChatTab(session, windowId)
      return
  }
}
