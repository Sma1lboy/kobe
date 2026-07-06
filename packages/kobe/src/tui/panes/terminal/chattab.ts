import { kobeCliInvocation } from "@/cli/invocation"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { localSpawnCwd } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  getSessionOptions,
  globalTasksPaneWidth,
  newWindow,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  runTmuxSequenceCapturing,
  sessionExists,
  setSessionOption,
  setWindowOption,
} from "@/tmux/client"
import {
  CLAUDE_PANE_PERCENT,
  OPS_PANE_PERCENT,
  OPS_PANE_ROLE,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  engineTabExitCleanup,
  keepAlive,
  opsPaneCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
  updatePageCommand,
} from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"
import { ALL_VENDORS } from "@/types/vendor"
import { CURRENT_VERSION } from "@/version"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { applyZenToNewWindow } from "./layout-actions"
import { PANE_VERSION_OPTION, globalRightColumnResizeArgs } from "./pane-heal"

export function chatTabSwitchBindings(prevKey: string, nextKey: string) {
  const guard = "#{?#{@kobe_surface},0,1}"
  return [
    ["bind-key", "-n", prevKey, "if-shell", "-F", guard, "previous-window"],
    ["bind-key", "-n", nextKey, "if-shell", "-F", guard, "next-window"],
  ] as const
}

export function chatTabCloseBinding(key: string, closeCommand = "kill-window") {
  return [
    "bind-key",
    "-n",
    key,
    "if-shell",
    "-F",
    "#{>:#{session_windows},1}",
    closeCommand,
    "display-message 'Cannot close the only ChatTab'",
  ] as const
}

export function chatTabRenameBinding(key: string) {
  return ["bind-key", "-n", key, "command-prompt", "-I", "#{window_name}", "rename-window -- '%%'"] as const
}

export const CHAT_TAB_ENGINE_PROMPT = `engine (${ALL_VENDORS.join("/")}/…)`

export function chatTabChooseEngineBindings(key: string) {
  return [
    ["bind-key", "-n", key, "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
    ["bind-key", "T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
  ] as const
}

function tmuxKeyCap(key: string): string {
  return key.startsWith("C-") && key.length === 3 ? `^${key.slice(2)}` : key
}

export function kobeStatusRight(keys: {
  focusLeft: string | null
  detach: string | null
  newTab: string | null
  layoutSplits?: string | null
  layoutPanes?: string | null
}): string {
  const segments = [
    keys.focusLeft ? `${tmuxKeyCap(keys.focusLeft)} tasks` : null,
    keys.detach ? `${tmuxKeyCap(keys.detach)} detach` : null,
    keys.newTab ? `${tmuxKeyCap(keys.newTab)} tab` : null,
    keys.layoutSplits ? `prefix ${keys.layoutSplits} splits` : null,
    keys.layoutPanes ? `prefix ${keys.layoutPanes} panes` : null,
  ].filter((s): s is string => s !== null)
  return `${segments.join("  ")} `
}

export const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"
export const CHAT_TAB_STATUS_FORMAT =
  "#{?#{==:#{@kobe_tab_state},running},●,#{?#{==:#{@kobe_tab_state},done},✓,#{?#{==:#{@kobe_tab_state},error},!,#{?#{==:#{@kobe_tab_state},unknown},?,○}}}} #I:#W"
export const CHAT_TAB_STATUS_CURRENT_FORMAT = CHAT_TAB_STATUS_FORMAT

export async function buildPanesAround(
  claudePane: string,
  args: { cwd: string; taskId?: string; opsCommand?: string; inv: readonly string[]; vendor?: string },
): Promise<void> {
  const envPrefix = inheritedEnvPrefix()
  const tasksWidth = await globalTasksPaneWidth()

  const opsCmd = keepAlive(
    args.opsCommand ??
      envPrefix +
        opsPaneCommand({
          cwd: args.cwd,
          taskId: args.taskId,
          claudePaneId: claudePane,
          cliInvocation: args.inv,
          vendor: args.vendor,
        }),
  )

  const { stdout } = await runTmuxSequenceCapturing([
    ["set-option", "-p", "-t", claudePane, "@kobe_role", "claude"],
    ["set-window-option", "-t", claudePane, CHAT_TAB_STATE_OPTION, "idle"],
    [
      "split-window",
      "-h",
      "-b",
      "-t",
      claudePane,
      "-l",
      `${tasksWidth}`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "tasks=#{pane_id}",
      keepAlive(envPrefix + tasksPaneCommand(args.inv, { initialTaskId: args.taskId })),
    ],
    [
      "split-window",
      "-h",
      "-t",
      claudePane,
      "-l",
      `${100 - CLAUDE_PANE_PERCENT}%`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "ops=#{pane_id}",
      opsCmd,
    ],
    [
      "split-window",
      "-v",
      "-l",
      `${100 - OPS_PANE_PERCENT}%`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "shell=#{pane_id}",
    ],
    ["select-pane", "-t", claudePane],
  ])
  const ids = Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("=", 2)),
  )
  await runTmuxSequence([
    ...(ids.tasks ? ([["set-option", "-p", "-t", ids.tasks, "@kobe_role", TASKS_PANE_ROLE]] as const) : []),
    ...(ids.tasks ? ([["set-option", "-p", "-t", ids.tasks, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, "@kobe_role", OPS_PANE_ROLE]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
    ...(ids.shell ? ([["set-option", "-p", "-t", ids.shell, "@kobe_role", SHELL_PANE_ROLE]] as const) : []),
  ])

  if (ids.ops) {
    const rcArgs = await globalRightColumnResizeArgs()
    if (rcArgs.length > 0) await runTmux(["resize-pane", "-t", ids.ops, ...rcArgs])
  }
}

export async function newChatTab(session: string, vendorOverride?: VendorId): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, [
    "@kobe_worktree",
    "@kobe_task",
    "@kobe_vendor",
    REMOTE_KEY_OPTION,
  ])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const remoteKey = sessionOptions[REMOTE_KEY_OPTION] || undefined
  const vendor = vendorOverride ?? (sessionOptions["@kobe_vendor"] as VendorId | undefined)
  if (vendorOverride) {
    await rememberSessionVendor(session, taskId, vendorOverride)
    try {
      const { resolveMainRepoRoot } = await import("../../../state/repos.ts")
      const { setRepoLastActiveVendor } = await import("../../../state/vendor-prefs.ts")
      setRepoLastActiveVendor(resolveMainRepoRoot(cwd), vendorOverride)
    } catch {}
  }
  const command = interactiveEngineCommand(vendor)
  const launch = withClaudeSessionId(command, vendor)
  const inv = kobeCliInvocation()
  const r = await runTmuxCapturing([
    "new-window",
    "-t",
    `=${session}`,
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive(
      wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd),
      engineTabExitCleanup(inheritedEnvPrefix(), inv, session),
    ),
  ])
  const claudePane = r.stdout.trim()
  if (!claudePane) return
  if (launch.sessionId) await setWindowOption(claudePane, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)
  await buildPanesAround(claudePane, { cwd, taskId, inv, vendor })
  const { stdout: winOut } = await runTmuxCapturing(["display-message", "-p", "-t", claudePane, "#{window_id}"])
  const windowId = winOut.trim()
  if (windowId) await applyZenToNewWindow(session, windowId)
}

export async function openSettingsTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} settings`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "settings", surface: true })
}

export async function openWorktreesTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} worktrees`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "worktrees", surface: true })
}

export async function openHelpTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} help-page`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "help", surface: true })
}

export async function openNewTaskTab(session: string, defaultRepo?: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const repoArg = defaultRepo ? ` --repo ${shellQuote(defaultRepo)}` : ""
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} new-task${repoArg}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "new task", surface: true })
}

export async function openUpdateTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${updatePageCommand({ cliInvocation: inv })}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "update", surface: true })
}

export async function quickCreate(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} quick-task --session ${shellQuote(session)}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "quick task", surface: true })
}

async function rememberSessionVendor(session: string, taskId: string | undefined, vendor: VendorId): Promise<void> {
  await setSessionOption(session, "@kobe_vendor", vendor)
  if (!taskId) return
  try {
    const { connectOrStartDaemon } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
    const client = await connectOrStartDaemon()
    try {
      await client.request("task.setVendor", { taskId, vendor })
    } finally {
      client.close()
    }
  } catch (err) {
    console.error("[kobe tmux] failed to persist selected engine vendor:", err)
  }
}
