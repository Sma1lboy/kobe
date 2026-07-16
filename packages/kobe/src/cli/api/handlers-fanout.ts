/**
 * Verb handlers for fan-out, collect, and feedback — grouped separately
 * from `handlers-tasks.ts` since they don't touch single-task CRUD.
 * Split out of `api-cmd.ts` (see that file's header).
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { DEFAULT_FEEDBACK_CATEGORY_SLUG, submitFeedback } from "../../lib/feedback.ts"
import { ulid } from "../../orchestrator/index/ulid.ts"
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

  // Every sibling of this round shares one groupId, so the grouping outlives
  // this CLI call (the JSON output used to be its only record). Siblings share
  // the prompt, so bare titles would converge onto the SAME name — an explicit
  // --title gets its `#i/N` ordinal here; placeholder-titled siblings get
  // theirs appended by the daemon's auto-title pass (keyed on groupId) when
  // the prompt-derived name lands.
  const groupId = ulid()

  // Create serially — task.create is a pure store write (worktrees are lazy,
  // materialized during delivery below), and ordered creation keeps `#i/N`
  // ordinals aligned with tasks.json order. Delivery then runs concurrently:
  // sessions are task-id isolated, so N cold-boot waits overlap (5 tasks:
  // ~6s, not ~30s). A mid-loop create failure must NOT orphan the tasks
  // already created — carry them into the PARTIAL_FANOUT payload so a script
  // can retry/archive them instead of double-spawning.
  const created: Array<{ taskId: string; vendor: VendorId; task: SerializedTask }> = []
  let createFailure: { vendor: VendorId; error: { message: string; code: string } } | null = null
  for (const [i, vendor] of plan.entries()) {
    const payload: Record<string, string> = { repo, vendor, groupId }
    if (title) payload.title = plan.length > 1 ? `${title} #${i + 1}/${plan.length}` : title
    if (baseRef) payload.baseRef = baseRef
    try {
      const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
      created.push({ taskId: res.taskId, vendor, task: res.task })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "CREATE_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      createFailure = { vendor, error: { message, code } }
      break
    }
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

  // A create-stage failure is a failure row WITHOUT a taskId (nothing was
  // created for it) — but the siblings created before it are real, engine-
  // burning tasks whose ids must reach the script.
  if (createFailure) failures.push({ ok: false, vendor: createFailure.vendor, error: createFailure.error })

  const result = { count: created.length, requested: plan.length, groupId, tasks, failures }
  // Partial (or total) create/delivery failure must not exit 0 — carry the
  // whole result (created taskIds included) up so the dispatcher emits it to
  // stdout + exits 3.
  if (failures.length > 0) {
    throw new ApiError(`fan-out delivered ${tasks.length}/${plan.length}`, "PARTIAL_FANOUT", result)
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
    // `changes` is the UNCOMMITTED view; `base` is the committed one (ahead
    // count + diffstat vs the merge-base). Both matter when picking a
    // fan-out winner: an attempt that commits its work reads +0/−0 here.
    const changes = task.worktreePath ? await runtime.readWorktreeChanges(task.worktreePath) : { added: 0, deleted: 0 }
    const base = task.worktreePath
      ? await runtime.readBranchSignals(task.worktreePath)
      : { baseRef: null, ahead: null, diff: null }
    out.push({
      taskId: task.id,
      title: task.title,
      branch: task.branch,
      worktreePath: task.worktreePath,
      vendor: task.vendor,
      status: task.status,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      running,
      changes,
      base,
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
