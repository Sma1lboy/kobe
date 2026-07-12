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
  ensurePtyHost,
  findEngineKey,
  killTaskSessions,
  listSessions,
  openPtyHost,
  taskKeys,
} from "./pty-delivery.ts"
import { ApiError, type ApiRuntime, type DeliveredPrompt, type PromptDeliveryOps, type PromptTarget } from "./types.ts"

/** Ensure and address the task's sole hosted engine session. */
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
    const argv = interactiveEngineCommand(target.vendor, target.modelEffort)
    const launch = buildEngineSessionLaunch({
      task: { id: target.id, kind: target.kind, vendor: target.vendor, repo: target.repo },
      worktreePath: worktree,
      shell: process.env.SHELL?.trim() || "/bin/zsh",
      argv,
      promptIntent: { kind: "explicit", prompt },
    })
    const result = await deliverHostedPrompt(host.rpc, { id: target.id, engineBin: argv[0] }, worktree, prompt, launch)
    if (result.started && !result.engineReady) {
      throw new ApiError(`failed to start hosted engine session for ${target.id}`, "SESSION_FAILED")
    }
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
