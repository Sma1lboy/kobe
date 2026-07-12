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

  // Create serially (concurrent `git worktree add` in one repo races), then
  // deliver concurrently — the sessions are task-id isolated, so N cold-boot
  // waits run in parallel instead of stacking (5 tasks: ~6s, not ~30s).
  const created: Array<{ taskId: string; vendor: VendorId; task: SerializedTask }> = []
  for (const vendor of plan) {
    const payload: Record<string, string> = { repo, vendor }
    if (title) payload.title = title
    if (baseRef) payload.baseRef = baseRef
    const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
    created.push({ taskId: res.taskId, vendor, task: res.task })
  }

  const settled = await Promise.allSettled(
    created.map(({ taskId, vendor, task }) =>
      ctx.runtime.deliverPrompt(
        daemon,
        {
          id: taskId,
          worktreePath: task.worktreePath,
          kind: task.kind,
          vendor,
          modelEffort: task.modelEffort,
          repo: task.repo,
        },
        prompt,
      ),
    ),
  )

  const tasks: unknown[] = []
  const failures: unknown[] = []
  settled.forEach((r, i) => {
    const { taskId, vendor } = created[i]
    if (r.status === "fulfilled" && r.value.delivered) {
      tasks.push({
        ok: true,
        taskId,
        vendor,
        started: r.value.started,
        engineReady: r.value.engineReady,
        session: r.value.session,
      })
      return
    }
    // Either deliverPrompt threw, or it resolved but the paste never landed.
    // The task IS created (engine already burning tokens) — always carry its
    // taskId so a script can find/retry it instead of orphaning it.
    const err =
      r.status === "rejected"
        ? r.reason
        : new ApiError(`prompt was not confirmed in ${taskId}'s engine`, "NOT_DELIVERED")
    const code = err instanceof ApiError ? err.code : "DELIVER_FAILED"
    const message = err instanceof Error ? err.message : String(err)
    failures.push({ ok: false, taskId, vendor, error: { message, code } })
  })

  const result = { count: created.length, tasks, failures }
  // Partial (or total) delivery failure must not exit 0 — carry the whole
  // result (created taskIds included) up so the dispatcher emits it + exits 3.
  if (failures.length > 0) {
    throw new ApiError(`fan-out delivered ${tasks.length}/${created.length}`, "PARTIAL_FANOUT", result)
  }
  return result
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
