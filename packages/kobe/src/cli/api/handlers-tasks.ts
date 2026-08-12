/**
 * Verb handlers for task CRUD + prompt delivery + issue-update — the
 * `read` / `create` / `drive` / `edit` / `lifecycle` / `worktree` groups
 * that aren't a one-line `simpleRpc` inline in the {@link VERBS} table.
 * Split out of `api-cmd.ts` (see that file's header).
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { kobeApiInvocation } from "../../engine/interactive-command.ts"
import type { TaskStatus } from "../../types/task.ts"
import type { VendorId } from "../../types/vendor.ts"
import type { DaemonRpc } from "../daemon-session.ts"
import { daemonOf, dispatcherEnvPayload, simpleRpc } from "./handler-helpers.ts"
import { resolveActiveTaskId } from "./runtime.ts"
import { ApiError, type ApiRuntime, type VerbContext } from "./types.ts"

/**
 * Peer provenance: a `send` issued from INSIDE another kobe task is one
 * agent messaging another, and the receiver needs what a bare paste never
 * carries — who is talking and how to answer. Same convention as field
 * notes (`[KOBE FIELD NOTE] from "<label>" (task <id>)`), plus the reply
 * command so a peer conversation is symmetric without any coordinator.
 * Sender identity comes from $KOBE_TASK_ID (exported into every engine
 * tab); a send from a plain shell (no env) or to yourself stays untouched.
 */
async function withPeerProvenance(daemon: DaemonRpc, targetTaskId: string, prompt: string): Promise<string> {
  const senderId = process.env.KOBE_TASK_ID
  if (!senderId || senderId === targetTaskId) return prompt
  let label = senderId
  try {
    const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId: senderId })
    label = res.task.title || res.task.branch || senderId
  } catch {
    /* stale env id — keep id-only provenance rather than dropping it */
  }
  const api = kobeApiInvocation()
  // The baked-in reply command carries the sender's TAB, not just its task
  // (issue #21): task-granular replies land on canonical-tab resolution,
  // which is exactly the link that breaks (#19) — tab-precise addressing is
  // the loop's durable route home. $KOBE_TAB_ID is exported into every
  // engine tab alongside $KOBE_TASK_ID (session-launch.ts).
  const senderTab = process.env.KOBE_TAB_ID
  const replyTarget = `--task-id ${senderId}${senderTab ? ` --tab ${senderTab}` : ""}`
  // The trailing pointer closes the loop for a receiver that has never seen
  // kobe: reply command baked in, and where to learn the rest (the herdr
  // "--skill first" trick) — a pointer, not a curriculum, since every peer
  // message pays for this prefix in context. Loading the skill is REQUIRED,
  // not suggested: a receiver that replies from the raw prefix alone
  // improvises verbs and side-channels (2026-08-10: a peer coordination
  // round-trip fell back to a human relay because neither side had the
  // skill's contract in context).
  return `[KOBE PEER] from "${label}" (task ${senderId} — load the kobe agent skill FIRST (required, e.g. /kobe), then reply: \`${api} send ${replyTarget} --prompt "<text>"\`; verb reference: \`${api} schema\`): ${prompt}`
}

export async function issueUpdate(ctx: VerbContext): Promise<unknown> {
  const title = ctx.args.str("title")
  const body = ctx.args.str("body")
  const task = ctx.args.str("task")
  if (title === undefined && body === undefined && task === undefined) {
    throw new ApiError("issue-update requires --title, --body, and/or --task", "MISSING_FLAG")
  }
  const repoRoot = ctx.args.requirePath("repo")
  const id = ctx.args.int("id")
  let result: unknown
  if (title !== undefined || body !== undefined) {
    result = await simpleRpc(ctx, "issue.mutate", { repoRoot, op: { type: "update", id, title, body } })
  }
  if (task !== undefined) {
    // `--task none` unlinks; anything else links. Linking IS the kanban move to
    // In progress — the board column derives from the link, not a stored column.
    const op = task === "none" ? { type: "unlink", id } : { type: "link", id, taskId: task }
    result = await simpleRpc(ctx, "issue.mutate", { repoRoot, op })
  }
  return result
}

export async function add(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  // Record who dispatched this create (issue #21) — the reply address a
  // sub-task's bare `send` routes its outcome back to.
  const payload: Record<string, string> = { repo, ...dispatcherEnvPayload() }
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
    {
      id: taskId,
      worktreePath: task.worktreePath,
      kind: task.kind,
      vendor: task.vendor as VendorId | undefined,
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
 * The dispatcher recorded on the CALLER's own task, when the caller is a
 * kobe session with one. `null` (keep the active-task default) when the
 * caller isn't a kobe session, the task predates the field or was created
 * outside a kobe session, or the env id is stale.
 */
async function readOwnDispatcher(daemon: DaemonRpc): Promise<SerializedTask["dispatcher"] | null> {
  const selfId = process.env.KOBE_TASK_ID
  if (!selfId) return null
  try {
    const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId: selfId })
    return res.task.dispatcher ?? null
  } catch {
    return null
  }
}

/**
 * Pick the tab a dispatcher-defaulted `send` lands on: the exact tab the
 * work was dispatched from first, the dispatcher task's canonical live
 * engine tab when that tab has died, and NEVER a silent spawn — with
 * nothing alive the send fails loud with a typed error, per the 2026-08-12
 * collaboration-verb design principle (a fallback must not impersonate
 * success).
 */
async function resolveDispatcherTab(
  runtime: ApiRuntime,
  dispatcher: { readonly taskId: string; readonly tabId: string },
): Promise<string | undefined> {
  const { tabs, running } = await runtime.taskTabs(dispatcher.taskId)
  // The dispatched-from tab first, addressed only when it reads ALIVE: the
  // tab join now also lists live sessions the persisted snapshot never
  // registered (issue #20), so "present and alive" is the honest liveness
  // test and a tab that is merely gone from the snapshot still gets the
  // canonical fallback below instead of a TAB_NOT_FOUND at delivery.
  if (tabs.some((t) => t.id === dispatcher.tabId && t.alive)) return dispatcher.tabId
  // Dead dispatcher tab → the task's canonical live engine (tab omitted).
  // Gated on a live engine tab existing: entering the canonical delivery
  // path with nothing alive would silently boot a NEW engine (issue #19's
  // failure mode) instead of reaching the dispatcher.
  if (running) return undefined
  throw new ApiError(
    `dispatcher tab ${dispatcher.tabId} on task ${dispatcher.taskId} is dead and the task has no live engine tab — the reply has nowhere to land`,
    "DISPATCHER_UNREACHABLE",
    {
      dispatcher,
      hint: "address an alive target explicitly with --task-id/--tab (see `kobe api pty-list`), or notify the user with `kobe api notify`",
      nextCommandArgs: ["api", "pty-list"],
    },
  )
}

export async function send(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const prompt = ctx.args.require("prompt")
  let tab = ctx.args.str("tab")
  if (tab && tab !== "new" && !/^tab-[A-Za-z0-9-]+$/.test(tab)) {
    throw new ApiError(`--tab must be "new" or a tab id like tab-2 (got ${JSON.stringify(tab)})`, "BAD_TAB")
  }
  let taskId = ctx.args.str("task-id")
  if (!taskId) {
    // Inside a sub-task, a bare `send` is the reply verb: it defaults to the
    // DISPATCHER (task + tab) that created this task, not the global active
    // task — the loop's outcome contract (55c990f34) routes completion back
    // to the dispatching chat tab. An explicit --tab keeps its exact-tab
    // semantics (on the dispatcher task); the fallback chain only runs for
    // the tab default.
    const dispatcher = await readOwnDispatcher(daemon)
    if (dispatcher) {
      taskId = dispatcher.taskId
      if (tab === undefined) tab = await resolveDispatcherTab(ctx.runtime, dispatcher)
    } else {
      const active = await resolveActiveTaskId(daemon)
      if (!active) {
        throw new ApiError(
          "no --task-id given and no active task — open a task first or pass --task-id",
          "MISSING_TARGET",
        )
      }
      taskId = active
    }
  }
  const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const text = ctx.args.bool("plain") ? prompt : await withPeerProvenance(daemon, taskId, prompt)
  const delivered = await ctx.runtime.deliverPrompt(
    daemon,
    {
      id: taskId,
      worktreePath: res.task.worktreePath,
      kind: res.task.kind,
      vendor: res.task.vendor as VendorId | undefined,
      modelEffort: res.task.modelEffort,
      repo: res.task.repo,
      tab,
    },
    text,
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
  // One liveness read serves both: `.running` (any live engine tab) and the
  // per-tab `.alive` an agent needs to pick a `send --tab tab-N` target.
  const { tabs, running } = await ctx.runtime.taskTabs(taskId)
  return { task: res.task, running, tabs }
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
  // survives, but the live hosted session + engine subprocess must not keep
  // burning resources. Unarchive is the inverse — it must NOT kill (the session
  // is rebuilt fresh on next enter), so teardown is gated on `archived === true`.
  // Hosted-session teardown runs here in the CLI process,
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
  // hosted session. Without this, a scripted delete
  // orphans the `kobe-<id>` session + its engine — invisible to every kobe UI
  // since the task is gone from tasks.json. Mirror the TUI's finishDeletedTaskFlow
  // and kill it here, after the delete RPC succeeds.
  await ctx.runtime.tearDownSession(taskId)
  return res
}

export async function land(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const strategy = ctx.args.str("strategy") === "squash" ? "squash" : "merge"
  const removeWorktree = ctx.args.bool("remove-worktree") ?? false
  const res = await daemon.request<{ result: unknown }>("task.land", {
    taskId,
    strategy,
    deleteBranch: ctx.args.bool("delete-branch") ?? false,
    archive: ctx.args.bool("then-archive") ?? false,
    removeWorktree,
    // The daemon refuses to remove the worktree the caller is running from —
    // it can only know where the caller is if we tell it.
    ...(removeWorktree ? { callerCwd: process.cwd() } : {}),
  })
  return { ok: true, taskId, ...(res.result as object) }
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
