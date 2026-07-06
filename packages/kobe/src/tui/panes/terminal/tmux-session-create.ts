import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId, withDispatcherProtocol, withWorktreeProtocol } from "@/engine/interactive-command"
import { worktreeInitMarkerPath } from "@/env"
import { localSpawnCwd, remoteKeyForRepo } from "@/exec/resolve"
import { archivedHistoryPreviewEnabled } from "@/state/archived-history"
import { CHAT_TAB_SESSION_ID_OPTION, runTmux, runTmuxCapturing, runTmuxSequence, setWindowOption } from "@/tmux/client"
import { deliverFirstEngineMessage } from "@/tmux/prompt-delivery"
import {
  engineLaunchLine,
  engineTabExitCleanup,
  historyPaneKeepAlive,
  resolveRepoInitTimeoutSeconds,
  shellQuoteArgv,
} from "@/tmux/session-layout"
import { applyTmuxChromeTheme } from "@/tui/lib/tmux-border-theme"
import { buildPanesAround } from "./chattab"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { installSessionBindings } from "./tmux-session-bindings.ts"
import type { EnsureSessionOpts } from "./tmux-session.ts"
import { attachedWindowInfo, tmuxInitialSizeArgs } from "./tmux.ts"

export async function createSession(opts: EnsureSessionOpts): Promise<boolean> {
  const launchInit = opts.launchInit
  const remoteKey = remoteKeyForRepo(opts.repo)
  const inv = kobeCliInvocation()
  const historyPreview = (opts.archived === true || opts.preview === true) && archivedHistoryPreviewEnabled()
  const launch = historyPreview
    ? { argv: [] as readonly string[], sessionId: undefined }
    : withClaudeSessionId(opts.command, opts.vendor)
  const isMainSession = opts.repo !== undefined && opts.cwd === opts.repo
  const protocolTaskId = isMainSession || remoteKey ? undefined : opts.taskId
  const dispatcherTaskId = isMainSession && !remoteKey ? opts.taskId : undefined
  const launchArgv = withDispatcherProtocol(
    withWorktreeProtocol(launch.argv, opts.vendor, protocolTaskId),
    opts.vendor,
    dispatcherTaskId,
  )
  const historyArgv = [
    ...inv,
    "history",
    "--worktree",
    opts.archivedWorktree ?? opts.cwd,
    ...(opts.vendor ? ["--vendor", opts.vendor] : []),
    ...(opts.title ? ["--title", opts.title] : []),
    ...(opts.preview && !opts.archived ? ["--live"] : []),
  ]
  const engineCmd = wrapEngineLaunch(shellQuoteArgv(historyPreview ? historyArgv : launchArgv), remoteKey, opts.cwd)
  const paneCommand = historyPreview
    ? historyPaneKeepAlive(engineCmd)
    : engineLaunchLine(
        engineCmd,
        {
          initScript: remoteKey ? undefined : launchInit?.initScript,
          markerPath: !remoteKey && launchInit?.initScript ? worktreeInitMarkerPath(opts.cwd) : undefined,
          timeoutSeconds: resolveRepoInitTimeoutSeconds(process.env.KOBE_REPO_INIT_TIMEOUT_SECONDS),
        },
        engineTabExitCleanup(inheritedEnvPrefix(), inv, opts.name),
      )
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    localSpawnCwd(opts.cwd),
    ...tmuxInitialSizeArgs(),
    "-P",
    "-F",
    "#{pane_id}",
    paneCommand,
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return false
  }
  if (launch.sessionId) await setWindowOption(pane0, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)

  await runTmuxSequence([
    ...(opts.taskId ? ([["set-option", "-t", opts.name, "@kobe_task", opts.taskId]] as const) : []),
    ["set-option", "-t", opts.name, "@kobe_worktree", opts.cwd],
    ...(opts.vendor ? ([["set-option", "-t", opts.name, "@kobe_vendor", opts.vendor]] as const) : []),
    ...(remoteKey ? ([["set-option", "-t", opts.name, REMOTE_KEY_OPTION, remoteKey]] as const) : []),
  ])

  if (process.env.TMUX) {
    const { sizeArgs } = await attachedWindowInfo()
    if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${opts.name}`, ...sizeArgs])
  }

  await buildPanesAround(pane0, {
    cwd: opts.cwd,
    taskId: opts.taskId,
    opsCommand: opts.opsCommand,
    inv,
    vendor: opts.vendor,
  })

  await installSessionBindings(inv)

  await applyTmuxChromeTheme()

  await runTmux(["select-pane", "-t", pane0])

  const firstMessage = launchInit?.firstMessage
  if (firstMessage) {
    void deliverFirstEngineMessage(opts.name, firstMessage).catch((err) =>
      console.error("[kobe tmux] first message delivery failed:", err),
    )
  }
  return true
}
