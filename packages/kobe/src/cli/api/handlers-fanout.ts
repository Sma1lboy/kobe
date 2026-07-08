/**
 * Verb handlers for fan-out, collect, and feedback — grouped separately
 * from `handlers-tasks.ts` since they don't touch single-task CRUD.
 * Split out of `api-cmd.ts` (see that file's header).
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { DEFAULT_FEEDBACK_CATEGORY_SLUG, submitFeedback } from "../../lib/feedback.ts"
import type { VendorId } from "../../types/vendor.ts"
import { FANOUT_CAP, buildCountPlan, parseAgentsSpec } from "./flags.ts"
import { daemonOf } from "./handler-helpers.ts"
import { ApiError, type VerbContext } from "./types.ts"

export async function fanOut(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  const prompt = args.require("prompt")
  const title = args.str("title")
  const baseRef = args.str("base-branch")

  const agentsSpec = args.str("agents")
  const defaultVendor = await runtime.defaultVendor(repo)
  const plan: VendorId[] = agentsSpec
    ? parseAgentsSpec(agentsSpec)
    : buildCountPlan(args.int("count") ?? 1, args.vendor() ?? defaultVendor ?? "claude")

  if (plan.length > FANOUT_CAP) {
    throw new ApiError(`fan-out of ${plan.length} exceeds the cap of ${FANOUT_CAP} — spawn in batches`, "BAD_FLAG")
  }

  const tasks: unknown[] = []
  for (const vendor of plan) {
    const payload: Record<string, string> = { repo, vendor }
    if (title) payload.title = title
    if (baseRef) payload.baseRef = baseRef
    const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
    const delivered = await ctx.runtime.deliverPrompt(
      daemon,
      { id: res.taskId, worktreePath: res.task.worktreePath, vendor, repo: res.task.repo },
      prompt,
    )
    tasks.push({
      taskId: res.taskId,
      vendor,
      started: delivered.started,
      engineReady: delivered.engineReady,
      session: delivered.session,
    })
  }
  return { count: tasks.length, tasks }
}

export async function collect(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const idsFlag = args.str("task-ids")
  const repoFlag = args.path("repo")

  let taskIds: string[]
  if (idsFlag) {
    taskIds = idsFlag
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (repoFlag) {
    const target = await runtime.resolveRepoRoot(repoFlag)
    const { tasks } = await daemon.request<{ tasks: SerializedTask[] }>("task.list")
    taskIds = []
    for (const t of tasks) {
      if (t.archived) continue
      if ((await runtime.resolveRepoRoot(t.repo)) === target) taskIds.push(t.id)
    }
  } else {
    throw new ApiError("collect needs --task-ids id1,id2 or --repo PATH", "MISSING_TARGET")
  }

  const out: unknown[] = []
  for (const taskId of taskIds) {
    const { task } = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
    const running = await runtime.isTaskRunning(taskId)
    const changes = task.worktreePath ? await runtime.readWorktreeChanges(task.worktreePath) : { added: 0, deleted: 0 }
    out.push({
      taskId: task.id,
      title: task.title,
      branch: task.branch,
      worktreePath: task.worktreePath,
      vendor: task.vendor,
      status: task.status,
      running,
      changes,
    })
  }
  return { tasks: out }
}

export async function feedback(ctx: VerbContext): Promise<unknown> {
  const result = submitFeedback({
    title: ctx.args.require("title"),
    body: ctx.args.require("body"),
    categorySlug: ctx.args.str("category"),
  })
  return { ok: true, discussion: result }
}
