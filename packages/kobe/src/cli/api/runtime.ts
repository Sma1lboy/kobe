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
import { deliverToKey, findEngineKey, killTaskSessions, listSessions, openPtyHost, taskKeys } from "./pty-delivery.ts"
import { ApiError, type ApiRuntime, type DeliveredPrompt, type PromptDeliveryOps, type PromptTarget } from "./types.ts"

/**
 * Deliver into a task's daemon-hosted engine session if one exists.
 * Returns `null` when the pty host has NO session for the task (so delivery
 * falls back to tmux). When the task IS hosted but no engine key resolves
 * (or the paste target is dead), returns `delivered:false` — the caller
 * must honour that and never build a tmux session, or two engines run in
 * one worktree. `session`/`pane` carry the hosted key so the result shape
 * matches the tmux path.
 */
async function deliverHosted(target: PromptTarget, worktree: string, prompt: string): Promise<DeliveredPrompt | null> {
  const host = await openPtyHost()
  if (!host) return null
  try {
    const sessions = await listSessions(host.rpc)
    if (taskKeys(sessions, target.id).length === 0) return null // not hosted → tmux
    const key = findEngineKey(sessions, target.id, interactiveEngineCommand(target.vendor)[0])
    if (!key) {
      // Hosted, but the engine tab is gone — refuse rather than double-open.
      return { session: "", pane: "", started: false, engineReady: false, delivered: false }
    }
    const delivered = await deliverToKey(host.rpc, key, worktree, prompt)
    return { session: key, pane: key, started: false, engineReady: delivered, delivered }
  } finally {
    host.close()
  }
}

const realPromptDeliveryOps: PromptDeliveryOps = {
  sessionExists,
  ensureSession: async (opts) => (await import("../../tui/panes/terminal/tmux.ts")).ensureSession(opts),
  waitForEnginePane,
  pasteAndSubmit,
  resolveEngineLaunchInit: async (repoRoot, worktreePath, intent) =>
    (await import("../../state/repo-init.ts")).resolveEngineLaunchInit(repoRoot, worktreePath, intent),
  engineCommand: interactiveEngineCommand,
  deliverHosted,
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

  // Hosted backend (default) FIRST: if the pty host has any session for this
  // task, its engine lives there — deliver into it and STOP. Building a tmux
  // session would double-open a second engine in the same worktree (two
  // agents clobbering the same files). Only when the task has NO hosted
  // session at all do we fall through to the tmux path below.
  const hosted = await ops.deliverHosted(target, worktree, prompt)
  if (hosted) return hosted

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
  // Hosted (pty-host) engine counts as running FIRST — otherwise a hosted
  // task looks idle to `send`/`fan-out`, which then builds a second tmux
  // engine in the same worktree (the double-open bug this slice closes).
  isTaskRunning: async (taskId) => {
    const host = await openPtyHost()
    if (host) {
      try {
        const sessions = await listSessions(host.rpc)
        if (findEngineKey(sessions, taskId) !== null) return true
      } finally {
        host.close()
      }
    }
    return sessionExists(tmuxSessionName(taskId))
  },
  deliverPrompt: (client, target, prompt) => deliverPrompt(client, target, prompt),
  resolveRepoRoot: async (absPath) => (await import("../../state/repos.ts")).resolveMainRepoRoot(absPath),
  defaultVendor: async (repo) => {
    const { getGlobalDefaultVendor, getRepoLastActiveVendor } = await import("../../state/vendor-prefs.ts")
    return (repo ? getRepoLastActiveVendor(repo) : undefined) ?? getGlobalDefaultVendor()
  },
  readWorktreeChanges: async (worktreePath) =>
    (await import("../../tui/panes/sidebar/worktree-changes.ts")).readWorktreeChanges(worktreePath),
  tearDownSession: async (taskId) => {
    // Kill the HOSTED engine too (both backends): teardown fires only from
    // archive/delete — genuine "stop this task's engine" moments — and a
    // hosted engine otherwise survives forever with no owner. The daemon's
    // archive sweep eventually kills it, but that's keyed on the daemon
    // seeing the flag; kill it here now, mirroring the tmux teardown.
    const host = await openPtyHost()
    if (host) {
      try {
        await killTaskSessions(host.rpc, taskKeys(await listSessions(host.rpc), taskId))
      } catch {
        /* pty-host hiccup must not fail the already-committed RPC */
      } finally {
        host.close()
      }
    }
    const session = tmuxSessionName(taskId)
    // Switch any attached client away first so a kill doesn't blank a terminal
    // (no-op when this process isn't on that session), then kill the session +
    // its engine. Both are swallowed — the task is already gone from the index.
    await switchClientBeforeKill(session).catch(() => {})
    await killSession(session).catch(() => {})
  },
}
