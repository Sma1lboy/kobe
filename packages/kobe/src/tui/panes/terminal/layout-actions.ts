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
import { setZenActive, zenIsActive, zenKeepsTasks } from "@/state/zen"
import {
  getSessionOption,
  getSessionOptions,
  readLayoutGeometry,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
  setSessionOption,
  termWindowPaneGroups,
} from "@/tmux/client"
import {
  ENGINE_PANE_ROLE,
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_PANE_PERCENT,
  OPS_PANE_ROLE,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  WORKSPACE_AUX_PANE_ROLE,
  WORKSPACE_SPLIT_MAX_PANES,
  ZEN_HIDDEN_PANES_OPTION,
  ZEN_SESSION_OPTION,
  clampPanePercent,
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
  | "zen-toggle"
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
  return (await readLayoutGeometry()).tasksWidth
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
  return (await readLayoutGeometry()).opsHeightPct
}

async function preferredRightColumnWidthPercent(): Promise<number> {
  return (await readLayoutGeometry()).rightColumnWidthPct
}

async function preferredTerminalHeightPercent(): Promise<number> {
  return expandedTerminalHeightPercent((await readLayoutGeometry()).opsHeightPct)
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

/**
 * Zen mode is SESSION-GLOBAL: one toggle collapses every engine ChatTab in the
 * session down to its engine pane, and a freshly created ChatTab opens collapsed
 * too (see {@link applyZenToNewWindow}), so zen survives tab switches and new
 * tabs. The on/off state lives in the session option {@link ZEN_SESSION_OPTION};
 * each window still records WHICH roles it hid in {@link ZEN_HIDDEN_PANES_OPTION}
 * so leaving zen restores exactly those panes and nothing the user had already
 * collapsed themselves. Idempotent: a second toggle reverses it across all tabs.
 */
async function toggleZenSession(session: string): Promise<void> {
  // Zen is a GLOBAL toggle: flip the persisted intent (so every other project's
  // session follows when entered, via syncSessionZen) and apply it to THIS
  // session right now. The per-session `@kobe_zen` option remains the local
  // "is this session collapsed" record that enter/exit set.
  const on = zenIsActive()
  setZenActive(!on)
  if (on) {
    await exitZenSession(session)
    return
  }
  await enterZenSession(session)
}

/**
 * Reconcile one session's layout to the GLOBAL zen intent. Called when entering
 * a session (switchTo / initial attach) so a project you switch to inherits the
 * global on/off state even though its tmux session was never toggled directly.
 * No-op when the session already matches (idempotent) or doesn't exist.
 */
export async function syncSessionZen(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const want = zenIsActive()
  const has = (await getSessionOption(session, ZEN_SESSION_OPTION)).length > 0
  if (want === has) return
  if (want) await enterZenSession(session)
  else await exitZenSession(session)
}

/** Window ids of the session, in tmux order. */
async function sessionWindowIds(session: string): Promise<string[]> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
  if (code !== 0) return []
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** A window is an engine ChatTab (not a Settings/help/new-task surface) iff it has an engine pane. */
async function windowHasEnginePane(session: string, windowId: string): Promise<boolean> {
  const rows = await windowPanes(session, windowId)
  return !!rows?.some((row) => row.role === ENGINE_PANE_ROLE)
}

async function enterZenSession(session: string): Promise<void> {
  const windowIds = await sessionWindowIds(session)
  for (const windowId of windowIds) {
    if (!(await windowHasEnginePane(session, windowId))) continue
    if (await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)) continue // already collapsed
    await enterZenMode(session, windowId)
  }
  await setSessionOption(session, ZEN_SESSION_OPTION, "1")
  await display(`=${session}`, "kobe: Zen mode on — all tabs")
}

async function exitZenSession(session: string): Promise<void> {
  const windowIds = await sessionWindowIds(session)
  for (const windowId of windowIds) {
    const recorded = await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)
    if (recorded) await exitZenMode(session, windowId, recorded)
  }
  await runTmux(["set-option", "-u", "-t", session, ZEN_SESSION_OPTION])
  await display(`=${session}`, "kobe: Zen mode off — all tabs")
}

/**
 * Collapse a freshly built ChatTab if the session is in zen mode, so new tabs
 * (Ctrl+T / quick-create) and tabs the user switches to stay focused. No-op
 * when zen is off or the window is already collapsed. Called by `newChatTab`
 * after its panes are built.
 */
export async function applyZenToNewWindow(session: string, windowId: string): Promise<void> {
  const sessionZen = (await getSessionOption(session, ZEN_SESSION_OPTION)).length > 0
  // Collapse when this session is already in zen OR the GLOBAL intent is on (a
  // freshly created session — e.g. a never-entered task's first window — has no
  // session option yet but should still inherit global zen). Seed the session
  // option so its later tabs collapse too.
  if (!sessionZen && !zenIsActive()) return
  if (!sessionZen) await setSessionOption(session, ZEN_SESSION_OPTION, "1")
  if (await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)) return
  if (!(await windowHasEnginePane(session, windowId))) return
  await enterZenMode(session, windowId)
}

async function enterZenMode(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const hidden: string[] = []

  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  if (ops) {
    await runTmux(["kill-pane", "-t", ops.paneId])
    hidden.push(OPS_PANE_ROLE)
  }

  const shell = resolveShellPane(rows)
  if (shell) {
    await hideTerminalPane(session, windowId, shell)
    hidden.push(SHELL_PANE_ROLE)
  }

  if (!zenKeepsTasks()) {
    const tasks = rows.find((row) => row.role === TASKS_PANE_ROLE)
    if (tasks) {
      await hideTasksPane(session, windowId, tasks)
      hidden.push(TASKS_PANE_ROLE)
    }
  }

  if (hidden.length === 0) {
    await display(windowId, "kobe: already focused — nothing to hide")
    return
  }
  await setActiveWindowOption(windowId, ZEN_HIDDEN_PANES_OPTION, hidden.join(","))
  await display(windowId, "kobe: Zen mode on")
}

async function exitZenMode(session: string, windowId: string, recorded: string): Promise<void> {
  const roles = new Set(recorded.split(",").map((role) => role.trim()))

  // Restore the Tasks rail first (it re-splits off the engine pane on the
  // left), then the file/Ops pane and terminal which key off the engine /
  // each other — mirroring the build order so the geometry lands right.
  if (roles.has(TASKS_PANE_ROLE)) {
    const hiddenPane = await windowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
    if (hiddenPane) await restoreHiddenTasksPane(session, windowId, hiddenPane)
  }
  if (roles.has(OPS_PANE_ROLE)) {
    const rows = await windowPanes(session, windowId)
    if (rows && !rows.some((row) => row.role === OPS_PANE_ROLE)) await toggleOpsPane(session, windowId)
  }
  if (roles.has(SHELL_PANE_ROLE)) {
    const hiddenPane = await windowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
    if (hiddenPane) await restoreHiddenTerminalPane(session, windowId, hiddenPane)
  }

  await clearActiveWindowOption(windowId, ZEN_HIDDEN_PANES_OPTION)
  await display(windowId, "kobe: Zen mode off")
}

async function activeSessionWindowCount(session: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((line) => line.trim().length > 0).length
}

/**
 * `kill-window` only SIGHUPs panes; engine CLIs (claude) swallow HUP and
 * leak to init with a revoked tty (#205 class — issue #14). SIGTERM the
 * window's pane groups first, the same ladder `killSession` uses.
 */
async function killWindowWithPaneGroups(windowId: string): Promise<void> {
  await termWindowPaneGroups(windowId)
  await runTmux(["kill-window", "-t", windowId])
}

async function closeChatTab(session: string, windowId: string): Promise<void> {
  if ((await activeSessionWindowCount(session)) <= 1) {
    await display(windowId, "Cannot close the only ChatTab")
    return
  }
  await cleanupHiddenPanesForWindow(session, windowId)
  await killWindowWithPaneGroups(windowId)
}

/**
 * Tear down a chat tab whose engine the user fully exited (engine process
 * exited → fallback shell → user typed `exit`). Invoked by `kobe engine-tab-exit`
 * from that pane's own keepAlive `onExit` (see {@link engineTabExitCleanup}).
 *
 * Multi-tab: close this window; tmux moves the client to a sibling tab.
 * Only tab: do NOT kill the task's last window (that would end the whole task
 * session and orphan the client) — instead open a FRESH engine tab and then
 * close the gutted one, so the task always has a live engine. The old window id
 * is captured BEFORE `newChatTab` runs, because creating the new window makes it
 * the active one; we only kill the old window once a new active window exists.
 */
export async function engineTabExit(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const oldWindowId = await activeWindowId(session)
  if (!oldWindowId) return
  if ((await activeSessionWindowCount(session)) > 1) {
    await cleanupHiddenPanesForWindow(session, oldWindowId)
    await killWindowWithPaneGroups(oldWindowId)
    return
  }
  // Only tab → replace it. Dynamic import: chattab statically imports this
  // module ({@link applyZenToNewWindow}), so a static import here would cycle.
  const { newChatTab } = await import("./chattab")
  await newChatTab(session)
  // Kill the gutted window only if a fresh active window actually took over —
  // otherwise newChatTab failed and we must not kill the task's last window.
  if ((await activeWindowId(session)) !== oldWindowId) {
    await cleanupHiddenPanesForWindow(session, oldWindowId)
    await killWindowWithPaneGroups(oldWindowId)
  }
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
    case "zen-toggle":
      // Zen is session-global: ignore the per-window target and toggle every tab.
      await toggleZenSession(session)
      return
    case "chat-tab-close":
      await closeChatTab(session, windowId)
      return
  }
}
