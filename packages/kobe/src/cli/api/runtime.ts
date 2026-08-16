/**
 * The real side-effect implementations `kobe api` verbs run against
 * outside tests: hosted prompt delivery and the
 * default {@link ApiRuntime}. Split out of `api-cmd.ts` (see that file's
 * header) — handlers depend on the `ApiRuntime` TYPE from `./types.ts`,
 * not this module, so unit tests never open PTY Host or git processes.
 */

import type { PtySessionExit } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { engineLaunchArgv } from "../../engine/engine-presets.ts"
import { withClaudeSessionId } from "../../engine/interactive-command.ts"
import { buildEngineSessionLaunch } from "../../engine/session-launch.ts"
import { trustEngineWorktree } from "../../engine/trust-worktree.ts"
import type { DaemonRpc } from "../daemon-session.ts"
import { verifiedSelfSession } from "./dispatcher.ts"
import {
  deliverHostedPrompt,
  deliverToExactTab,
  ensurePtyHost,
  killTaskSessions,
  listSessions,
  openPtyHost,
  taskKeys,
} from "./pty-delivery.ts"
import {
  type TaskSessionRow,
  hasLiveEngineTab,
  joinTaskTabs,
  markCliTabSession,
  mintCliTab,
  publishCliTabSnapshot,
  readTabsSnapshot,
} from "./tab-snapshot.ts"
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
      const engineBin = engineLaunchArgv({
        command: target.command,
        vendor: target.vendor,
        effort: target.modelEffort,
      })[0]
      return await deliverToExactTab(host.rpc, target.id, target.tab, worktree, prompt, { engineBin })
    }
    const newTab = target.tab === "new" ? mintCliTab(target.id, target.tabVendor, target.tabCommand) : undefined
    // A `--tab new` pin (command and/or protocol) applies to THIS launch
    // only; the task's own engine is left alone.
    const launchVendor = target.tabVendor ?? target.vendor
    const launchCommand = target.tabCommand ?? (target.tabVendor ? undefined : target.command)
    // Pin the conversation's session id up front (claude only — the same
    // `withClaudeSessionId` contract the TUI launches with), so a LATER
    // reattach after a pty-host restart can resume THIS conversation
    // instead of opening a blank one. The id lands in the persisted tab
    // snapshot below once the session actually started.
    const { argv, sessionId } = withClaudeSessionId(
      engineLaunchArgv({ command: launchCommand, vendor: launchVendor, effort: target.modelEffort }),
      launchVendor,
    )
    // Pre-trust the worktree in the protocol's first-run store (issue #28) —
    // a hosted session can't answer a trust dialog. A generic protocol has
    // no store kobe knows how to pre-answer, and trustEngineWorktree no-ops.
    trustEngineWorktree(launchVendor, worktree)
    const launch = buildEngineSessionLaunch({
      task: { id: target.id, kind: target.kind, vendor: launchVendor, repo: target.repo },
      worktreePath: worktree,
      shell: process.env.SHELL?.trim() || "/bin/zsh",
      argv,
      // Spawner identity is resolved HERE, in the CLI process — an `add` run
      // from inside an engine tab carries the spawner's $KOBE_TASK_ID, and
      // the coda tells the new agent to `send` its outcome back
      // (repo-init.ts). VERIFIED, not raw env: an inherited id would write a
      // stranger's task into the worker's own instructions (issue #24), which
      // is the one place a wrong address survives even after the record is
      // right — it's baked into the prompt, not read back from the store.
      promptIntent: target.newTask
        ? { kind: "new-task", prompt, spawnerTaskId: (await verifiedSelfSession())?.taskId }
        : { kind: "explicit", prompt },
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
    // in mintCliTab); see `tab-snapshot.ts`. When THIS delivery started the
    // session, record the pinned session id + spawned flag too, so a later
    // dead-reattach resumes the conversation (see engineTabArgv).
    if (result.started && sessionId) {
      if (newTab) markCliTabSession(target.id, newTab, sessionId)
      else publishCliTabSnapshot(target.id, sessionId)
    } else if (!newTab) publishCliTabSnapshot(target.id)
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
  isTaskRunning: async (taskId) => (await defaultApiRuntime.taskTabs(taskId)).running,
  taskTabs: async (taskId) => {
    // No host = no sessions, an honest "nothing alive"; the persisted tabs
    // still return so a stopped task's layout stays inspectable.
    let sessions: readonly (TaskSessionRow & { pid?: number | null })[] = []
    const host = await openPtyHost()
    if (host) {
      try {
        sessions = await listSessions(host.rpc)
      } finally {
        host.close()
      }
    }
    // Live foreground-walk verdicts per session (issue #33): ONE ps snapshot,
    // the same shallowest-engine walk inspect/live-engine run — so get-task's
    // `liveVendor` reflects what runs NOW, not what a mounted TUI last
    // recorded. Best-effort: a failed ps just keeps the recorded values.
    let liveVendors: Map<string, string | null> | undefined
    try {
      const { foregroundEngineIn, parsePsSnapshot, psSnapshot } = await import("../../engine/foreground.ts")
      const walkable = sessions.filter((s) => s.alive && typeof s.pid === "number" && s.pid > 0)
      if (walkable.length > 0) {
        const rows = parsePsSnapshot(await psSnapshot())
        liveVendors = new Map(walkable.map((s) => [s.key, foregroundEngineIn(rows, s.pid as number)?.vendor ?? null]))
      }
    } catch {
      /* recorded liveVendor stays */
    }
    // Durable death records outlive the host's idle-exit — a crashed tab
    // still reports its cause here. Best-effort: unreadable = none.
    let exits: Readonly<Record<string, PtySessionExit>> = {}
    try {
      exits = (await import("@sma1lboy/kobe-daemon/daemon/pty-exit-store")).readPtyExitRecords()
    } catch {
      /* keep tabs readable without the records */
    }
    const snapshot = readTabsSnapshot(taskId)
    return {
      tabs: joinTaskTabs(snapshot, taskId, sessions, exits, liveVendors),
      running: hasLiveEngineTab(snapshot, taskId, sessions),
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
