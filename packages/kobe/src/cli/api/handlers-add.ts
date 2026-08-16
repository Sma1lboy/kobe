/**
 * The `add` verb — the one create path, single or parallel.
 *
 * `fan-out` used to be a separate verb for "N tasks of one prompt"; it was
 * the same create-then-deliver loop with a count, and having two verbs meant
 * an agent had to know which one to reach for before it knew how many
 * attempts it wanted. `add --count N` (and `--agents claude:2,codex:1`) is
 * that verb folded back in: `--count` absent = exactly one task, and the
 * whole parallel contract (shared `groupId`, `#i/N` titles, per-sibling
 * failure rows, PARTIAL_FANOUT) applies unchanged from N=2 up.
 *
 * Split out of `handlers-tasks.ts` (file-size cap) rather than living beside
 * `send`: create-with-fleet is its own concern now.
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { resolveCommandProtocol } from "../../engine/engine-presets.ts"
import { ulid } from "../../orchestrator/index/ulid.ts"
import type { TaskStatus } from "../../types/task.ts"
import type { VendorId } from "../../types/vendor.ts"
import { dispatcherEnvPayload } from "./dispatcher.ts"
import { FANOUT_CAP, buildCountPlan, parseAgentsSpec } from "./flags.ts"
import { daemonOf } from "./handler-helpers.ts"
import { ApiError, type VerbContext, helpStep } from "./types.ts"

/** The engine fields a create carries: the raw command + its resolved protocol. */
interface EngineChoice {
  readonly command?: string
  readonly vendor?: VendorId
}

/**
 * Resolve `--command` into what a task record needs. A bare preset id stays
 * verbatim in `command` (so a later `engineCommand.<id>` edit in Settings
 * still reaches this task) with its declared protocol alongside; a full
 * command line records both too. No `--command` = the repo's default engine,
 * which is a preset id, so it goes in the same two fields.
 */
async function engineChoice(ctx: VerbContext, repo: string): Promise<EngineChoice> {
  const command = ctx.args.str("command")
  if (command) return { command, vendor: resolveCommandProtocol(command) }
  const fallback = await ctx.runtime.defaultVendor(repo)
  return fallback ? { command: fallback, vendor: fallback } : {}
}

/** The engine fields as a flat `task.create` payload fragment. */
function enginePayload(choice: EngineChoice): Record<string, string> {
  return { ...(choice.command ? { command: choice.command } : {}), ...(choice.vendor ? { vendor: choice.vendor } : {}) }
}

export async function add(ctx: VerbContext): Promise<unknown> {
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  const count = args.int("count")
  const agentsSpec = args.str("agents")
  if (count !== undefined || agentsSpec) return addParallel(ctx, repo, count, agentsSpec)
  return addOne(ctx, repo)
}

async function addOne(ctx: VerbContext, repo: string): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  // Record who dispatched this create (issue #21) — the reply address a
  // sub-task's bare `send` routes its outcome back to.
  const choice = await engineChoice(ctx, repo)
  const payload: Record<string, string> = { repo, ...dispatcherEnvPayload(), ...enginePayload(choice) }
  const title = args.str("title")
  if (title) payload.title = title
  const branch = args.str("branch")
  if (branch) payload.branch = branch
  const baseRef = args.str("base-branch")
  if (baseRef) payload.baseRef = baseRef

  const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
  const taskId = res.taskId
  // Only steal the shared active-task focus (which every mounted TUI's Tasks
  // pane follows) when explicitly asked — a background agent/cron building
  // tasks must not yank the user's focus on every create. Matches the
  // parallel path, which never setActive, and the "opening content doesn't
  // pull focus" taste.
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
    {
      id: taskId,
      worktreePath: task.worktreePath,
      kind: task.kind,
      vendor: task.vendor as VendorId | undefined,
      command: task.command,
      modelEffort: task.modelEffort,
      repo: task.repo,
      newTask: true,
    },
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

/**
 * `--count N` / `--agents e:2,f:1`: N sibling tasks of ONE prompt, each in
 * its own worktree + branch. Every sibling of this round shares one groupId,
 * so the grouping outlives this CLI call (the JSON output used to be its only
 * record). Siblings share the prompt, so bare titles would converge onto the
 * SAME name — an explicit --title gets its `#i/N` ordinal here; placeholder-
 * titled siblings get theirs appended by the daemon's auto-title pass (keyed
 * on groupId) when the prompt-derived name lands.
 */
async function addParallel(
  ctx: VerbContext,
  repo: string,
  count: number | undefined,
  agentsSpec: string | undefined,
): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  // A parallel round with nothing to deliver would spawn N idle worktrees —
  // the prompt IS the round.
  const prompt = args.str("prompt")
  if (!prompt) {
    throw new ApiError(
      "--count/--agents spawn parallel attempts of ONE prompt — pass --prompt",
      "MISSING_FLAG",
      helpStep("add"),
    )
  }
  if (args.str("branch")) {
    throw new ApiError(
      "--branch names ONE branch and cannot be shared by parallel siblings — drop it (each sibling gets its own auto branch) or spawn them one at a time",
      "BAD_FLAG",
      helpStep("add"),
    )
  }
  // `--agents` already names an engine per sibling AND how many of each, so
  // `--command` / `--count` alongside it have nothing left to say. Refuse
  // rather than silently ignore — a caller who wrote both believes both
  // applied, and a fleet is expensive to spawn wrong (same reasoning as
  // `send --command` without `--tab new`).
  if (agentsSpec) {
    const conflict = count !== undefined ? "--count" : args.str("command") ? "--command" : null
    if (conflict) {
      throw new ApiError(
        `${conflict} conflicts with --agents, which already names each sibling's engine and how many — pass one or the other`,
        "BAD_FLAG",
        helpStep("add"),
      )
    }
  }
  const title = args.str("title")
  const baseRef = args.str("base-branch")

  // `--agents` names engines per sibling; `--count` repeats ONE engine, which
  // is `--command`'s when given (a full command line included — the plan just
  // carries its protocol, and every sibling launches the same command).
  const choice = await engineChoice(ctx, repo)
  const plan: VendorId[] = agentsSpec
    ? parseAgentsSpec(agentsSpec)
    : buildCountPlan(count ?? 1, choice.vendor ?? "claude")
  if (plan.length > FANOUT_CAP) {
    throw new ApiError(
      `a parallel round of ${plan.length} exceeds the cap of ${FANOUT_CAP} — spawn in batches`,
      "BAD_FLAG",
    )
  }
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
  // Every sibling records the same dispatcher (issue #21) — the reply
  // address each worker's bare `send` routes its outcome back to.
  const dispatcher = dispatcherEnvPayload()
  for (const [i, vendor] of plan.entries()) {
    // `--agents` picks each sibling's engine BY ID, so its command is that
    // id; a `--count` round reuses the caller's own `--command` verbatim.
    const engine: EngineChoice = agentsSpec ? { command: vendor, vendor } : { ...choice, vendor }
    const payload: Record<string, string> = { repo, groupId, ...dispatcher, ...enginePayload(engine) }
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
          command: task.command,
          modelEffort: task.modelEffort,
          repo: task.repo,
          newTask: true,
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
    throw new ApiError(`add delivered ${tasks.length}/${plan.length}`, "PARTIAL_FANOUT", result)
  }
  return result
}
