/**
 * Verb handlers for task CRUD + prompt delivery + issue-update — the
 * `read` / `create` / `drive` / `edit` / `lifecycle` / `worktree` groups
 * that aren't a one-line `simpleRpc` inline in the {@link VERBS} table.
 * Split out of `api-cmd.ts` (see that file's header).
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { TaskStatus } from "../../types/task.ts"
import type { VendorId } from "../../types/vendor.ts"
import { daemonOf, simpleRpc } from "./handler-helpers.ts"
import { resolveActiveTaskId } from "./runtime.ts"
import { ApiError, type VerbContext } from "./types.ts"

export async function issueUpdate(ctx: VerbContext): Promise<unknown> {
  const title = ctx.args.str("title")
  const body = ctx.args.str("body")
  if (title === undefined && body === undefined) {
    throw new ApiError("issue-update requires --title and/or --body", "MISSING_FLAG")
  }
  return simpleRpc(ctx, "issue.mutate", {
    repoRoot: ctx.args.requirePath("repo"),
    op: { type: "update", id: ctx.args.int("id"), title, body },
  })
}

export async function add(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  const payload: Record<string, string> = { repo }
  const title = args.str("title")
  if (title) payload.title = title
  const branch = args.str("branch")
  if (branch) payload.branch = branch
  const baseRef = args.str("base-branch")
  if (baseRef) payload.baseRef = baseRef
  const vendor = args.vendor() ?? (await runtime.defaultVendor(repo))
  if (vendor) payload.vendor = vendor

  const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
  const taskId = res.taskId
  // Only steal the shared active-task focus (which every mounted TUI's Tasks
  // pane follows) when explicitly asked — a background agent/cron building
  // tasks must not yank the user's focus on every create. Matches fan-out,
  // which never setActive, and the "opening content doesn't pull focus" taste.
  if (args.bool("activate")) await daemon.request("task.setActive", { taskId })

  // status / pin aren't create-time fields on the RPC — apply them as
  // follow-ups so `add` is the one-stop "make me a task exactly like this".
  const status = args.enumOf<TaskStatus>("status")
  if (status) await daemon.request("task.status", { taskId, status })
  const pin = args.bool("pin")
  if (pin !== undefined) await daemon.request("task.pin", { taskId, pinned: pin })

  let task = res.task
  if (status || pin !== undefined) {
    task = (await daemon.request<{ task: SerializedTask }>("task.get", { taskId })).task
  }

  const prompt = args.str("prompt")
  if (!prompt) return { taskId, task, started: false }
  const delivered = await ctx.runtime.deliverPrompt(
    daemon,
    { id: taskId, worktreePath: task.worktreePath, vendor: task.vendor as VendorId | undefined, repo: task.repo },
    prompt,
  )
  task = (await daemon.request<{ task: SerializedTask }>("task.get", { taskId })).task
  // A prompt that never confirmed in the composer is a failure — but the task
  // IS created, so carry the taskId in the error so a script can find it.
  if (!delivered.delivered) {
    throw new ApiError(
      `task ${taskId} created but the prompt was not delivered (paste did not land)`,
      "NOT_DELIVERED",
      {
        taskId,
      },
    )
  }
  return {
    taskId,
    task,
    started: delivered.started,
    engineReady: delivered.engineReady,
    session: delivered.session,
    delivered: delivered.delivered,
  }
}

export async function send(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const prompt = ctx.args.require("prompt")
  let taskId = ctx.args.str("task-id")
  if (!taskId) {
    const active = await resolveActiveTaskId(daemon)
    if (!active) {
      throw new ApiError(
        "no --task-id given and no active task — open a task first or pass --task-id",
        "MISSING_TARGET",
      )
    }
    taskId = active
  }
  const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const delivered = await ctx.runtime.deliverPrompt(
    daemon,
    {
      id: taskId,
      worktreePath: res.task.worktreePath,
      vendor: res.task.vendor as VendorId | undefined,
      repo: res.task.repo,
    },
    prompt,
  )
  // A prompt that never landed in the composer is a delivery FAILURE the
  // script must see — non-zero exit, not a phantom `ok:true`.
  if (!delivered.delivered) {
    throw new ApiError(`prompt was not confirmed in ${taskId}'s engine (paste did not land)`, "NOT_DELIVERED")
  }
  return {
    ok: true,
    taskId,
    session: delivered.session,
    started: delivered.started,
    engineReady: delivered.engineReady,
  }
}

export async function dispatch(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const text = ctx.args.require("prompt")
  await daemon.request("session.deliver", { taskId, text, source: "dispatcher" })
  return { ok: true, taskId, routed: "session.deliver" }
}

export async function note(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const text = ctx.args.require("text")
  return await daemon.request("note.file", { taskId, text })
}

export async function getTask(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const running = await ctx.runtime.isTaskRunning(taskId)
  return { task: res.task, running }
}

export async function list(ctx: VerbContext): Promise<unknown> {
  return daemonOf(ctx).request<{ tasks: SerializedTask[] }>("task.list")
}

export async function setActive(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const none = ctx.args.bool("none")
  const taskId = none ? null : ctx.args.require("task-id")
  await daemon.request("task.setActive", { taskId })
  return { ok: true, activeTaskId: taskId }
}

export async function archive(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const archived = ctx.args.bool("archived") ?? true
  const res = await daemon.request("task.archive", { taskId, archived })
  // Archiving STOPS the engine (matching the TUI's archiveTaskFlow + the verb's
  // own "non-destructive: worktree/branch/history stay" contract): the data
  // survives, but the live tmux session + engine subprocess must not keep
  // burning resources. Unarchive is the inverse — it must NOT kill (the session
  // is rebuilt fresh on next enter), so teardown is gated on `archived === true`.
  // The daemon never touches tmux, so the kill runs here in the CLI process,
  // only after the RPC has committed the flag.
  if (archived) await ctx.runtime.tearDownSession(taskId)
  return res
}

export async function deleteTask(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const force = ctx.args.bool("force") ?? false
  const res = await daemon.request("task.delete", { taskId, force })
  // The daemon's task.delete removes the worktree + index entry but never the
  // tmux session (it doesn't import tmux). Without this, a scripted delete
  // orphans the `kobe-<id>` session + its engine — invisible to every kobe UI
  // since the task is gone from tasks.json. Mirror the TUI's finishDeletedTaskFlow
  // and kill it here, after the delete RPC succeeds.
  await ctx.runtime.tearDownSession(taskId)
  return res
}

export async function adopt(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  const input: Record<string, string> = {
    repo: args.requirePath("repo"),
    worktreePath: args.requirePath("worktree"),
  }
  const branch = args.str("branch")
  if (branch) input.branch = branch
  const vendor = args.vendor()
  if (vendor) input.vendor = vendor
  const title = args.str("title")
  if (title) input.title = title
  return daemon.request<{ task: SerializedTask }>("worktree.adopt", input)
}
