/**
 * The real side-effect implementations `kobe api` verbs run against
 * outside tests: prompt delivery (tmux session build + paste) and the
 * default {@link ApiRuntime}. Split out of `api-cmd.ts` (see that file's
 * header) — handlers depend on the `ApiRuntime` TYPE from `./types.ts`,
 * not this module, so unit tests never pull in tmux/git.
 */

import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { killSession, sessionExists, switchClientBeforeKill, tmuxSessionName } from "../../tmux/client.ts"
import { REPO_INIT_TIMEOUT_SECONDS } from "../../tmux/launch-line.ts"
import { FRESH_PANE_BUDGET_SECONDS, pasteAndSubmit, waitForEnginePane } from "../../tmux/prompt-delivery.ts"
import type { DaemonRpc } from "../daemon-session.ts"
import { ApiError, type ApiRuntime, type DeliveredPrompt, type PromptDeliveryOps, type PromptTarget } from "./types.ts"

const realPromptDeliveryOps: PromptDeliveryOps = {
  sessionExists,
  ensureSession: async (opts) => (await import("../../tui/panes/terminal/tmux.ts")).ensureSession(opts),
  waitForEnginePane,
  pasteAndSubmit,
  resolveEngineLaunchInit: async (repoRoot, worktreePath, intent) =>
    (await import("../../state/repo-init.ts")).resolveEngineLaunchInit(repoRoot, worktreePath, intent),
  engineCommand: interactiveEngineCommand,
}

export async function deliverPrompt(
  client: DaemonRpc,
  target: PromptTarget,
  prompt: string,
  ops: PromptDeliveryOps = realPromptDeliveryOps,
): Promise<DeliveredPrompt> {
  let worktree = target.worktreePath
  if (!worktree) {
    const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: target.id })
    worktree = res.worktreePath
  }
  if (!worktree) throw new ApiError(`task ${target.id} has no worktree`, "NO_WORKTREE")

  const session = tmuxSessionName(target.id)
  const existed = await ops.sessionExists(session)
  let hasInitScript = false
  if (!existed) {
    const launchInit = await ops.resolveEngineLaunchInit(target.repo ?? "", worktree, { kind: "none" })
    hasInitScript = Boolean(launchInit.initScript)
    const ok = await ops.ensureSession({
      name: session,
      cwd: worktree,
      command: ops.engineCommand(target.vendor),
      taskId: target.id,
      vendor: target.vendor,
      repo: target.repo,
      // The EXPLICIT prompt is delivered below; this contract intentionally
      // keeps only the init script so a fresh session never gets both pastes.
      launchInit,
    })
    if (!ok) throw new ApiError(`failed to start tmux session for ${target.id}`, "SESSION_FAILED")
  }

  // A repo `.kobe/init.sh` runs BEFORE the engine paints, so give the pane
  // wait the full init-script budget when one is present; otherwise stay
  // snappy. A reused session (existed) waits non-fresh with the short budget.
  const budgetSeconds = hasInitScript ? REPO_INIT_TIMEOUT_SECONDS : FRESH_PANE_BUDGET_SECONDS
  const { pane, ready } = await ops.waitForEnginePane(session, !existed, budgetSeconds)
  // No tagged engine pane (strict) ⇒ never blind-paste into a shell/ops pane.
  if (!pane) throw new ApiError(`no engine pane in session ${session}`, "NO_ENGINE_PANE")

  const delivered = await ops.pasteAndSubmit(pane, prompt)
  return { session, pane, started: !existed, engineReady: ready, delivered }
}

export async function resolveActiveTaskId(client: DaemonRpc): Promise<string | null> {
  let activeId: string | null = null
  const off = client.onChannel("active-task", (payload) => {
    activeId = payload.taskId
  })
  try {
    await client.subscribe()
  } finally {
    off()
  }
  return activeId
}

export const defaultApiRuntime: ApiRuntime = {
  isTaskRunning: (taskId) => sessionExists(tmuxSessionName(taskId)),
  deliverPrompt: (client, target, prompt) => deliverPrompt(client, target, prompt),
  resolveRepoRoot: async (absPath) => (await import("../../state/repos.ts")).resolveMainRepoRoot(absPath),
  defaultVendor: async (repo) => {
    const { getGlobalDefaultVendor, getRepoLastActiveVendor } = await import("../../state/vendor-prefs.ts")
    return (repo ? getRepoLastActiveVendor(repo) : undefined) ?? getGlobalDefaultVendor()
  },
  readWorktreeChanges: async (worktreePath) =>
    (await import("../../tui/panes/sidebar/worktree-changes.ts")).readWorktreeChanges(worktreePath),
  tearDownSession: async (taskId) => {
    const session = tmuxSessionName(taskId)
    // Switch any attached client away first so a kill doesn't blank a terminal
    // (no-op when this process isn't on that session), then kill the session +
    // its engine. Both are swallowed — the task is already gone from the index.
    await switchClientBeforeKill(session).catch(() => {})
    await killSession(session).catch(() => {})
  },
}
