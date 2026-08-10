/**
 * The real side-effect implementations `kobe api` verbs run against
 * outside tests: hosted prompt delivery and the
 * default {@link ApiRuntime}. Split out of `api-cmd.ts` (see that file's
 * header) — handlers depend on the `ApiRuntime` TYPE from `./types.ts`,
 * not this module, so unit tests never open PTY Host or git processes.
 */

import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { buildEngineSessionLaunch } from "../../engine/session-launch.ts"
import type { DaemonRpc } from "../daemon-session.ts"
import {
  deliverHostedPrompt,
  deliverToExactTab,
  ensurePtyHost,
  findEngineKey,
  killTaskSessions,
  listSessions,
  openPtyHost,
  taskKeys,
} from "./pty-delivery.ts"
import { mintCliTab, publishCliTabSnapshot } from "./tab-snapshot.ts"
import { ApiError, type ApiRuntime, type DeliveredPrompt, type PromptDeliveryOps, type PromptTarget } from "./types.ts"

/** Ensure and address the task's hosted engine session (`target.tab` routes:
 *  undefined = canonical, "new" = mint + spawn a fresh tab, "tab-N" = that
 *  exact alive tab only). */
async function deliverHosted(target: PromptTarget, worktree: string, prompt: string): Promise<DeliveredPrompt> {
  let host: Awaited<ReturnType<typeof ensurePtyHost>>
  try {
    host = await ensurePtyHost()
  } catch (error) {
    throw new ApiError(
      `failed to start PTY host for ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
      "SESSION_FAILED",
    )
  }
  try {
    // Exact-tab addressing: deliver-only, never spawn — a dead/absent tab is
    // the caller's error (TAB_NOT_FOUND), not a cue to boot a new engine.
    // engineBin covers the task's CUSTOM engine binary; builtins the
    // foreground gate recognizes on its own (cross-vendor send stays open).
    if (target.tab && target.tab !== "new") {
      const engineBin = interactiveEngineCommand(target.vendor, target.modelEffort)[0]
      return await deliverToExactTab(host.rpc, target.id, target.tab, worktree, prompt, { engineBin })
    }
    const newTab = target.tab === "new" ? mintCliTab(target.id) : undefined
    const argv = interactiveEngineCommand(target.vendor, target.modelEffort)
    const launch = buildEngineSessionLaunch({
      task: { id: target.id, kind: target.kind, vendor: target.vendor, repo: target.repo },
      worktreePath: worktree,
      shell: process.env.SHELL?.trim() || "/bin/zsh",
      argv,
      promptIntent: { kind: "explicit", prompt },
      tabId: newTab,
    })
    const result = await deliverHostedPrompt(
      host.rpc,
      { id: target.id, engineBin: argv[0] },
      worktree,
      prompt,
      launch,
      {
        forceNew: newTab !== undefined,
      },
    )
    if (result.started && !result.engineReady) {
      throw new ApiError(`failed to start hosted engine session for ${target.id}`, "SESSION_FAILED")
    }
    // Make the session visible to the sidebar tree, which lists a worktree's
    // tabs from the task's persisted snapshot — a CLI-started session used to
    // run live with no snapshot, so the tree showed the worktree with no tabs
    // under it at all. Write-once (a --tab new spawn already appended its tab
    // in mintCliTab); see `tab-snapshot.ts`.
    if (!newTab) publishCliTabSnapshot(target.id)
    return result
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      `hosted engine session failed for ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
      "SESSION_FAILED",
    )
  } finally {
    host.close()
  }
}

const realPromptDeliveryOps: PromptDeliveryOps = {
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

  const hosted = await ops.deliverHosted(target, worktree, prompt)
  if (!hosted) throw new ApiError(`failed to start hosted engine session for ${target.id}`, "SESSION_FAILED")
  return hosted
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
  isTaskRunning: async (taskId) => {
    const host = await openPtyHost()
    if (!host) return false
    try {
      return findEngineKey(await listSessions(host.rpc), taskId) !== null
    } finally {
      host.close()
    }
  },
  deliverPrompt: (client, target, prompt) => deliverPrompt(client, target, prompt),
  resolveRepoRoot: async (absPath) => (await import("../../state/repos.ts")).resolveMainRepoRoot(absPath),
  defaultVendor: async (repo) => {
    const { getGlobalDefaultVendor, getRepoLastActiveVendor } = await import("../../state/vendor-prefs.ts")
    return (repo ? getRepoLastActiveVendor(repo) : undefined) ?? getGlobalDefaultVendor()
  },
  readWorktreeChanges: async (worktreePath) =>
    (await import("../../tui/panes/sidebar/worktree-changes.ts")).readWorktreeChanges(worktreePath),
  readBranchSignals: async (worktreePath) => (await import("./branch-signals.ts")).readBranchSignals(worktreePath),
  tearDownSession: async (taskId) => {
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
  },
}
