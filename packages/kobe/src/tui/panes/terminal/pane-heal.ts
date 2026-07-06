import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId } from "@/engine/interactive-command"
import { localSpawnCwd } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  getSessionOptions,
  readLayoutGeometry,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
} from "@/tmux/client"
import {
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_HEIGHT_OPTION,
  RIGHT_COLUMN_WIDTH_OPTION,
  TASKS_WIDTH_OPTION,
  clampPanePercent,
  clampTasksPaneWidth,
  engineTabExitCleanup,
  keepAlive,
  opsPaneCommand,
  shellQuoteArgv,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import { applyTmuxChromeTheme } from "@/tui/lib/tmux-border-theme"
import { CURRENT_VERSION } from "@/version"
import { inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { recordGen } from "./layout-coord"

export const PANE_VERSION_OPTION = "@kobe_pane_version"

export type KobePaneRow = {
  windowId: string
  paneId: string
  role: string
  version: string
  paneWidth?: number
}

const KOBE_PANE_LIST_FORMAT = `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}\t#{pane_width}`

export function parseKobePaneRows(stdout: string): KobePaneRow[] {
  const rows: KobePaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [windowId, paneId, role, version, paneWidth] = line.split("\t")
    if (!windowId || !paneId || !role) continue
    const width = Number.parseInt(paneWidth?.trim() ?? "", 10)
    rows.push({
      windowId: windowId.trim(),
      paneId: paneId.trim(),
      role: role.trim(),
      version: version?.trim() ?? "",
      ...(Number.isFinite(width) ? { paneWidth: width } : {}),
    })
  }
  return rows
}

export function paneIdsByRole(rows: readonly KobePaneRow[], role: string): string[] {
  return rows.filter((row) => row.role === role).map((row) => row.paneId)
}

export function commandTargetPane(command: readonly string[]): string | null {
  const i = command.indexOf("-t")
  return i >= 0 && i + 1 < command.length ? (command[i + 1] ?? null) : null
}

export function dropCommandsForVanishedPanes(
  commands: readonly (readonly string[])[],
  presentPaneIds: ReadonlySet<string>,
): (readonly string[])[] {
  return commands.filter((cmd) => {
    const target = commandTargetPane(cmd)
    return target === null || presentPaneIds.has(target)
  })
}

export type PaneHealTarget =
  | { readonly role: "tasks"; readonly paneId: string }
  | { readonly role: "ops"; readonly paneId: string; readonly claudePaneId: string | null }

export function planPaneHeals(
  rows: readonly KobePaneRow[],
  opts: { readonly currentVersion: string; readonly force: boolean; readonly vendorChanged?: boolean },
): PaneHealTarget[] {
  const byWindow = new Map<string, KobePaneRow[]>()
  for (const row of rows) {
    const panes = byWindow.get(row.windowId) ?? []
    panes.push(row)
    byWindow.set(row.windowId, panes)
  }

  const targets: PaneHealTarget[] = []
  for (const panes of byWindow.values()) {
    const claudePane = panes.find((pane) => pane.role === "claude")?.paneId
    const tasksPane = panes.find((pane) => pane.role === "tasks")
    const opsPane = panes.find((pane) => pane.role === "ops")

    if (tasksPane && (opts.force || tasksPane.version !== opts.currentVersion)) {
      targets.push({ role: "tasks", paneId: tasksPane.paneId })
    }
    const opsNeedsRespawn = opts.force
      ? true
      : claudePane && (opts.vendorChanged || opsPane?.version !== opts.currentVersion)
    if (opsPane && opsNeedsRespawn) {
      targets.push({ role: "ops", paneId: opsPane.paneId, claudePaneId: claudePane ?? null })
    }
  }
  return targets
}

async function listKobePanes(session: string): Promise<KobePaneRow[] | null> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    KOBE_PANE_LIST_FORMAT,
  ])
  if (code !== 0) return null
  return parseKobePaneRows(stdout)
}

async function runHealBatchTolerant(session: string, commands: readonly (readonly string[])[]): Promise<void> {
  if (commands.length === 0) return
  const present = await listKobePanes(session)
  const filtered = present ? dropCommandsForVanishedPanes(commands, new Set(present.map((r) => r.paneId))) : commands
  if (filtered.length > 0) await runTmuxSequence(filtered)
}

function respawnCommandsFor(
  targets: readonly PaneHealTarget[],
  args: { cwd: string; taskId: string | undefined; vendor: string | undefined },
): (readonly string[])[] {
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const commands: (readonly string[])[] = []
  for (const target of targets) {
    const paneCommand =
      target.role === "tasks"
        ? tasksPaneCommand(inv, { initialTaskId: args.taskId })
        : opsPaneCommand({
            cwd: args.cwd,
            taskId: args.taskId,
            claudePaneId: target.claudePaneId,
            cliInvocation: inv,
            vendor: args.vendor,
          })
    commands.push(
      ["respawn-pane", "-k", "-t", target.paneId, "-c", localSpawnCwd(args.cwd), keepAlive(envPrefix + paneCommand)],
      ["set-option", "-p", "-t", target.paneId, "@kobe_role", target.role],
      ["set-option", "-p", "-t", target.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
    )
  }
  return commands
}

export type RelaunchEngineResult = "switched" | "no-engine-pane" | "respawn-failed"

export function classifyRelaunchOutcome(enginePaneCount: number, sequenceExitCode: number): RelaunchEngineResult {
  if (enginePaneCount === 0) return "no-engine-pane"
  return sequenceExitCode === 0 ? "switched" : "respawn-failed"
}

export async function relaunchEngineInAllWindows(
  session: string,
  cwd: string,
  command: readonly string[],
  remoteKey?: string,
  vendor?: string,
): Promise<RelaunchEngineResult> {
  const rows = await listKobePanes(session)
  if (!rows) return "no-engine-pane"
  const enginePanes = rows.filter((r) => r.role === "claude")
  if (enginePanes.length === 0) return "no-engine-pane"
  const localCwd = localSpawnCwd(cwd)
  const cleanup = engineTabExitCleanup(inheritedEnvPrefix(), kobeCliInvocation(), session)
  const commands: (readonly string[])[] = []
  for (const pane of enginePanes) {
    const launch = withClaudeSessionId(command, vendor)
    const cmd = keepAlive(wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd), cleanup)
    commands.push(["respawn-pane", "-k", "-c", localCwd, "-t", pane.paneId, cmd])
    commands.push(
      launch.sessionId
        ? ["set-window-option", "-t", pane.paneId, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId]
        : ["set-window-option", "-u", "-t", pane.paneId, CHAT_TAB_SESSION_ID_OPTION],
    )
  }
  const code = await runTmuxSequence(commands)
  return classifyRelaunchOutcome(enginePanes.length, code)
}

export async function globalRightColumnResizeArgs(): Promise<readonly string[]> {
  return (await readLayoutGeometry()).rightColumnResizeArgs
}

export async function workspaceLayoutPaneCommands(
  session: string,
  opts: { readonly force?: boolean } = {},
): Promise<{ rows: KobePaneRow[] | null; commands: (readonly string[])[] }> {
  const { tasksWidth, rightColumnResizeArgs: rcArgs } = await readLayoutGeometry()
  const rows = await listKobePanes(session)
  if (!rows) return { rows: null, commands: [] }
  const commands: (readonly string[])[] = []
  for (const row of rows) {
    if (row.role === "tasks" && (opts.force || row.paneWidth !== tasksWidth)) {
      commands.push(["resize-pane", "-t", row.paneId, "-x", `${tasksWidth}`])
    }
  }
  if (rcArgs.length > 0) {
    for (const row of rows) {
      if (row.role === "ops") commands.push(["resize-pane", "-t", row.paneId, ...rcArgs])
    }
  }
  return { rows, commands }
}

export async function healWorkspaceLayout(
  session: string,
  versions?: { cwd: string; taskId: string | undefined; vendor: string | undefined; vendorChanged?: boolean },
): Promise<void> {
  recordGen(session, "resize")
  const { rows, commands: planned } = await workspaceLayoutPaneCommands(session)
  if (!rows) return
  const commands: (readonly string[])[] = [...planned]
  if (versions) {
    commands.push(
      ...respawnCommandsFor(
        planPaneHeals(rows, {
          currentVersion: CURRENT_VERSION,
          force: false,
          vendorChanged: versions.vendorChanged,
        }),
        versions,
      ),
    )
  }
  await runHealBatchTolerant(session, commands)
}

export async function healSessionLayout(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  await healWorkspaceLayout(session)
}

export async function captureGlobalLayout(session: string): Promise<void> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    `#{@kobe_role}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}\t#{window_zoomed_flag}\t#{${HIDDEN_TERMINAL_PANE_OPTION}}\t#{${HIDDEN_TASKS_PANE_OPTION}}`,
  ])
  if (code !== 0) return
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0]?.trim() ?? "") !== "")
  if (rows.length === 0) return
  if (rows.some((cols) => cols[5]?.trim() === "1")) return
  if (rows.some((cols) => (cols[6]?.trim() ?? "") !== "")) return
  if (rows.some((cols) => (cols[7]?.trim() ?? "") !== "")) return
  if (!rows.some((cols) => cols[0]?.trim() === "shell")) return
  const winW = Number.parseInt(rows[0][3]?.trim() ?? "", 10)
  const winH = Number.parseInt(rows[0][4]?.trim() ?? "", 10)
  const sets: (readonly string[])[] = []
  const tasks = rows.find(([role]) => role?.trim() === "tasks")
  if (tasks) {
    const width = Number.parseInt(tasks[1]?.trim() ?? "", 10)
    if (Number.isFinite(width) && width > 0)
      sets.push(["set-option", "-s", TASKS_WIDTH_OPTION, `${clampTasksPaneWidth(width)}`])
  }
  const ops = rows.find(([role]) => role?.trim() === "ops")
  if (ops && Number.isFinite(winW) && winW > 0 && Number.isFinite(winH) && winH > 0) {
    const opsW = Number.parseInt(ops[1]?.trim() ?? "", 10)
    const opsH = Number.parseInt(ops[2]?.trim() ?? "", 10)
    const widthPct = Number.isFinite(opsW) ? clampPanePercent((100 * opsW) / winW) : null
    const heightPct = Number.isFinite(opsH) ? clampPanePercent((100 * opsH) / winH) : null
    if (widthPct !== null) sets.push(["set-option", "-s", RIGHT_COLUMN_WIDTH_OPTION, `${widthPct}`])
    if (heightPct !== null) sets.push(["set-option", "-s", OPS_HEIGHT_OPTION, `${heightPct}`])
  }
  if (sets.length > 0) await runTmuxSequence(sets)
}

export function shouldCaptureDrag(stdout: string): boolean {
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0]?.trim() ?? "") !== "")
  if (rows.length === 0) return false
  if (rows.some((cols) => cols[1]?.trim() === "1")) return false
  if (rows.some((cols) => (cols[2]?.trim() ?? "") !== "")) return false
  if (rows.some((cols) => (cols[3]?.trim() ?? "") !== "")) return false
  const roles = new Set(rows.map((cols) => cols[0]?.trim()))
  return roles.has("tasks") && roles.has("ops") && roles.has("shell")
}

export async function captureGlobalLayoutOnDrag(session: string): Promise<void> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    `#{@kobe_role}\t#{window_zoomed_flag}\t#{${HIDDEN_TERMINAL_PANE_OPTION}}\t#{${HIDDEN_TASKS_PANE_OPTION}}`,
  ])
  if (code !== 0 || !shouldCaptureDrag(stdout)) return
  await captureGlobalLayout(session)
}

export async function refreshKobeWorkspacePanes(session: string): Promise<void> {
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const vendor = sessionOptions["@kobe_vendor"] || undefined
  const rows = await listKobePanes(session)
  if (!rows) return
  const commands = respawnCommandsFor(planPaneHeals(rows, { currentVersion: CURRENT_VERSION, force: true }), {
    cwd,
    taskId,
    vendor,
  })
  await runHealBatchTolerant(session, commands)

  await applyTmuxChromeTheme()
}
