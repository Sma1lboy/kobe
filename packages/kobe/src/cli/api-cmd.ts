/**
 * `kobe api <verb>` — scriptable surface for agents driving kobe from a
 * shell (Bash tool / cron / arbitrary scripts).
 *
 * Each invocation is a short-lived process: connect to (or auto-start)
 * the daemon, do the work, print a JSON object to stdout, exit. Designed
 * for fan-out — spawn N tasks, send each a scoped prompt, poll state.
 *
 * v0.5 had this same command, but it was deleted when the headless
 * engine was removed (the daemon used to host live chat streams). v0.6
 * is tmux-native: the daemon is a single writer for the task index, and
 * an engine is the interactive `claude` / `codex` CLI running inside a
 * task's tmux session. So the v0.6 verbs map onto that reality —
 * `spawn-task` / `get-task` / `list` are daemon RPCs, and `send`
 * delivers a prompt by pasting it (tmux bracketed paste) into the task's
 * engine pane, so a multi-line prompt stays one turn.
 *
 * Surface (v0.6 — 6 verbs):
 *   spawn-task   --repo PATH [--prompt TEXT] [--title T] [--base-branch B] [--vendor V]
 *   fan-out      --repo PATH --prompt TEXT [--count N | --agents claude:2,codex:1]
 *   send         [--task-id ID] --prompt TEXT
 *   get-task     --task-id ID
 *   collect      --task-ids a,b,c | --repo PATH
 *   list
 *
 * Output contract:
 *   - success → one JSON object to stdout, `\n` terminated, exit 0
 *   - error   → `{ "error": { "message", "code" } }` to stderr, exit ≠ 0
 *   - `--pretty` → indent stdout JSON (humans only)
 *
 * The daemon is auto-started if it is not already running (same as
 * `kobe adopt`), so an agent script does not have to babysit it.
 */

import { resolve } from "node:path"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"
import type { SerializedTask } from "../daemon/protocol.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { sessionExists, tmuxSessionName } from "../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../tmux/prompt-delivery.ts"
import { ALL_VENDORS, type VendorId } from "../types/vendor.ts"

/** Verbs this command accepts, in help order. */
export const API_VERBS = ["spawn-task", "fan-out", "send", "get-task", "collect", "list"] as const
export type ApiVerb = (typeof API_VERBS)[number]

/** Safety cap on a single fan-out so a typo can't spawn a runaway fleet. */
export const FANOUT_CAP = 10

type Flags = Map<string, string>

interface ParsedArgs {
  readonly flags: Flags
  readonly pretty: boolean
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/**
 * Parse argv into a flag map + `--pretty` boolean. Accepts both
 * `--key=value` and `--key value`. `--pretty` is the only boolean flag.
 * Unknown forms throw a BAD_FLAG error.
 */
export function parseFlags(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>()
  let pretty = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      throw new ApiError(`unexpected positional arg: ${arg}`, "BAD_FLAG")
    }
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      if (key === "pretty") {
        pretty = value !== "false" && value !== "0"
      } else {
        flags.set(key, value)
      }
      continue
    }
    const key = arg.slice(2)
    if (key === "pretty") {
      pretty = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      throw new ApiError(`flag --${key} requires a value`, "BAD_FLAG")
    }
    flags.set(key, next)
    i += 1
  }
  return { flags, pretty }
}

function required(flags: Flags, key: string): string {
  const v = flags.get(key)
  if (v === undefined || v.length === 0) {
    throw new ApiError(`--${key} is required`, "MISSING_FLAG")
  }
  return v
}

function optional(flags: Flags, key: string): string | undefined {
  const v = flags.get(key)
  return v && v.length > 0 ? v : undefined
}

/** Validate an optional `--vendor` flag against the known vendor list. */
function optionalVendor(flags: Flags): VendorId | undefined {
  const raw = optional(flags, "vendor")
  if (raw === undefined) return undefined
  if (!ALL_VENDORS.includes(raw as VendorId)) {
    throw new ApiError(`--vendor must be one of ${ALL_VENDORS.join(", ")}`, "BAD_FLAG")
  }
  return raw as VendorId
}

/** Parse an optional positive-integer flag (`--count 3`). */
function optionalPositiveInt(flags: Flags, key: string): number | undefined {
  const raw = optional(flags, key)
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(`--${key} must be a positive integer`, "BAD_FLAG")
  }
  return n
}

/**
 * Parse a fan-out spec like `claude:2,codex:1` into a flat list with one
 * vendor entry per task to spawn (`[claude, claude, codex]`). Each
 * `vendor:count` pair is validated against the known vendor list.
 */
export function parseAgentsSpec(spec: string): VendorId[] {
  const out: VendorId[] = []
  for (const part of spec.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) throw new ApiError(`--agents entry "${trimmed}" must be vendor:count`, "BAD_FLAG")
    const vendor = trimmed.slice(0, colon)
    if (!ALL_VENDORS.includes(vendor as VendorId)) {
      throw new ApiError(`--agents vendor "${vendor}" must be one of ${ALL_VENDORS.join(", ")}`, "BAD_FLAG")
    }
    const count = Number.parseInt(trimmed.slice(colon + 1), 10)
    if (!Number.isInteger(count) || count <= 0) {
      throw new ApiError(`--agents count for "${vendor}" must be a positive integer`, "BAD_FLAG")
    }
    for (let i = 0; i < count; i++) out.push(vendor as VendorId)
  }
  if (out.length === 0) throw new ApiError('--agents specified no agents (e.g. "claude:2,codex:1")', "BAD_FLAG")
  return out
}

/** One-line usage banner for `kobe api` with no/bad verb. */
export function apiUsage(): string {
  return [
    "usage: kobe api <verb> [flags] [--pretty]",
    "",
    "verbs:",
    "  spawn-task  --repo PATH [--prompt TEXT] [--title T] [--base-branch B] [--vendor V]",
    "  fan-out     --repo PATH --prompt TEXT [--count N | --agents claude:2,codex:1] [--base-branch B]",
    "  send        [--task-id ID] --prompt TEXT",
    "  get-task    --task-id ID",
    "  collect     --task-ids a,b,c | --repo PATH",
    "  list",
    "",
    "Output is one JSON object on stdout (exit 0); errors are JSON on stderr (exit ≠ 0).",
  ].join("\n")
}

/** Write the success payload to stdout. Always `\n`-terminated. */
function emit(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  process.stdout.write(`${text}\n`)
}

/**
 * Write `{error:{message,code}}` to stderr and exit non-zero. Stderr is
 * used so `kobe api … | jq` doesn't choke on error text.
 */
function fail(message: string, code: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ error: { message, code } })}\n`)
  process.exit(exitCode)
}

/** Task metadata needed to find/build a session and its engine pane. */
interface PromptTarget {
  readonly id: string
  readonly worktreePath: string
  readonly vendor?: VendorId
  /** Repo root (git toplevel) — for per-repo init script resolution. */
  readonly repo?: string
}

/**
 * Deliver a prompt to a task's engine pane, building the task's tmux
 * session first if it is not already running. `engineReady` is false when
 * a freshly-built engine never confirmed it was ready within the wait
 * budget (the prompt is still pasted best-effort).
 */
async function deliverPrompt(
  client: KobeDaemonClient,
  target: PromptTarget,
  prompt: string,
): Promise<{ session: string; pane: string; started: boolean; engineReady: boolean }> {
  // task.create returns an empty worktreePath (the worktree is
  // materialized lazily); ensure it exists before we cwd a session into it.
  let worktree = target.worktreePath
  if (!worktree) {
    const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: target.id })
    worktree = res.worktreePath
  }
  if (!worktree) throw new ApiError(`task ${target.id} has no worktree`, "NO_WORKTREE")

  const session = tmuxSessionName(target.id)
  const existed = await sessionExists(session)
  if (!existed) {
    const { ensureSession } = await import("../tui/panes/terminal/tmux.ts")
    const { resolveRepoInit } = await import("../state/repo-init.ts")
    // Run the repo's init script before the engine. The init PROMPT is
    // intentionally NOT passed here: this flow delivers its own explicit
    // prompt below, which is the engine's first message instead.
    const init = resolveRepoInit(target.repo ?? "", worktree)
    const ok = await ensureSession({
      name: session,
      cwd: worktree,
      command: interactiveEngineCommand(target.vendor),
      taskId: target.id,
      vendor: target.vendor,
      initScript: init.initScript,
    })
    if (!ok) throw new ApiError(`failed to start tmux session for ${target.id}`, "SESSION_FAILED")
  }

  const { pane, ready } = await waitForEnginePane(session, !existed)
  if (!pane) throw new ApiError(`no engine pane in session ${session}`, "NO_ENGINE_PANE")

  await pasteAndSubmit(pane, prompt)
  return { session, pane, started: !existed, engineReady: ready }
}

/**
 * Read the daemon's current active task id (the session last
 * switched/entered into). It lives only as a last-value on the
 * `active-task` push channel, so we subscribe and read the replay the
 * daemon sends before the subscribe response. `null` if nothing is active.
 */
async function resolveActiveTaskId(client: KobeDaemonClient): Promise<string | null> {
  let activeId: string | null = null
  const off = client.onChannel("active-task", (payload) => {
    activeId = payload.taskId
  })
  try {
    // The daemon replays each populated channel's value as event frames
    // BEFORE the subscribe response; FIFO socket ordering means the
    // handler above has fired by the time this resolves.
    await client.subscribe()
  } finally {
    off()
  }
  return activeId
}

async function spawnTask(client: KobeDaemonClient, parsed: ParsedArgs): Promise<unknown> {
  const { flags } = parsed
  const payload: Record<string, string> = { repo: required(flags, "repo") }
  const title = optional(flags, "title")
  if (title) payload.title = title
  const baseRef = optional(flags, "base-branch")
  if (baseRef) payload.baseRef = baseRef
  const vendor = optionalVendor(flags)
  if (vendor) payload.vendor = vendor

  const res = await client.request<{ taskId: string; task: SerializedTask }>("task.create", payload)

  const prompt = optional(flags, "prompt")
  if (!prompt) {
    return { taskId: res.taskId, task: res.task, started: false }
  }
  const delivered = await deliverPrompt(
    client,
    {
      id: res.taskId,
      worktreePath: res.task.worktreePath,
      vendor: res.task.vendor as VendorId | undefined,
      repo: res.task.repo,
    },
    prompt,
  )
  return {
    taskId: res.taskId,
    task: res.task,
    started: delivered.started,
    engineReady: delivered.engineReady,
    session: delivered.session,
  }
}

async function send(client: KobeDaemonClient, parsed: ParsedArgs): Promise<unknown> {
  const { flags } = parsed
  const prompt = required(flags, "prompt")
  let taskId = optional(flags, "task-id")
  if (!taskId) {
    const active = await resolveActiveTaskId(client)
    if (!active) {
      throw new ApiError(
        "no --task-id given and no active task — open a task first or pass --task-id",
        "MISSING_TARGET",
      )
    }
    taskId = active
  }
  const res = await client.request<{ task: SerializedTask }>("task.get", { taskId })
  const delivered = await deliverPrompt(
    client,
    {
      id: taskId,
      worktreePath: res.task.worktreePath,
      vendor: res.task.vendor as VendorId | undefined,
      repo: res.task.repo,
    },
    prompt,
  )
  return {
    ok: true,
    taskId,
    session: delivered.session,
    started: delivered.started,
    engineReady: delivered.engineReady,
  }
}

async function getTask(client: KobeDaemonClient, parsed: ParsedArgs): Promise<unknown> {
  const taskId = required(parsed.flags, "task-id")
  const res = await client.request<{ task: SerializedTask }>("task.get", { taskId })
  // `running` tells a poller whether the task's engine session is live —
  // the v0.6 replacement for the old per-tab status, since transcripts
  // live in tmux now, not in the daemon.
  const running = await sessionExists(tmuxSessionName(taskId))
  return { task: res.task, running }
}

async function list(client: KobeDaemonClient): Promise<unknown> {
  return client.request<{ tasks: SerializedTask[] }>("task.list")
}

/**
 * `fan-out` — spawn N tasks of the same prompt in one call (the uzi-style
 * `--agents claude:2,codex:1` shape, or a flat `--count N` of one vendor).
 * Each task gets its own worktree + tmux session and the prompt delivered.
 * Spawns sequentially so worktree/slug allocation can't race.
 */
async function fanOut(client: KobeDaemonClient, parsed: ParsedArgs): Promise<unknown> {
  const { flags } = parsed
  const repo = required(flags, "repo")
  const prompt = required(flags, "prompt")
  const title = optional(flags, "title")
  const baseRef = optional(flags, "base-branch")

  const agentsSpec = optional(flags, "agents")
  const plan: VendorId[] = agentsSpec
    ? parseAgentsSpec(agentsSpec)
    : new Array<VendorId>(optionalPositiveInt(flags, "count") ?? 1).fill(optionalVendor(flags) ?? "claude")

  if (plan.length > FANOUT_CAP) {
    throw new ApiError(`fan-out of ${plan.length} exceeds the cap of ${FANOUT_CAP} — spawn in batches`, "BAD_FLAG")
  }

  const tasks: unknown[] = []
  for (const vendor of plan) {
    const payload: Record<string, string> = { repo, vendor }
    if (title) payload.title = title
    if (baseRef) payload.baseRef = baseRef
    const res = await client.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
    const delivered = await deliverPrompt(
      client,
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

/**
 * `collect` — aggregation snapshot for a set of tasks: identity, branch,
 * whether the session is live, and the worktree's uncommitted change
 * counts (so an orchestrating agent can compare attempts and pick a
 * winner). Read-only; never merges. Target via `--task-ids a,b,c` or all
 * non-archived tasks in `--repo PATH`.
 */
async function collect(client: KobeDaemonClient, parsed: ParsedArgs): Promise<unknown> {
  const { flags } = parsed
  const idsFlag = optional(flags, "task-ids")
  const repoFlag = optional(flags, "repo")

  let taskIds: string[]
  if (idsFlag) {
    taskIds = idsFlag
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (repoFlag) {
    const { resolveRepoRoot } = await import("../state/repos.ts")
    const target = resolveRepoRoot(resolve(process.cwd(), repoFlag))
    const { tasks } = await client.request<{ tasks: SerializedTask[] }>("task.list")
    taskIds = tasks.filter((t) => !t.archived && resolveRepoRoot(t.repo) === target).map((t) => t.id)
  } else {
    throw new ApiError("collect needs --task-ids id1,id2 or --repo PATH", "MISSING_TARGET")
  }

  const { readWorktreeChanges } = await import("../tui/panes/sidebar/worktree-changes.ts")
  const out: unknown[] = []
  for (const taskId of taskIds) {
    const { task } = await client.request<{ task: SerializedTask }>("task.get", { taskId })
    const running = await sessionExists(tmuxSessionName(taskId))
    const changes = task.worktreePath ? readWorktreeChanges(task.worktreePath) : { added: 0, deleted: 0 }
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

export async function runApiSubcommand(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    if (!verb) {
      fail(apiUsage(), "MISSING_VERB", 2)
    }
    process.stdout.write(`${apiUsage()}\n`)
    return
  }
  if (!API_VERBS.includes(verb as ApiVerb)) {
    fail(`unknown verb: ${verb}\n${apiUsage()}`, "BAD_VERB", 2)
  }

  let parsed: ParsedArgs
  try {
    parsed = parseFlags(rest)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  let client: KobeDaemonClient
  try {
    client = await connectOrStartDaemon()
  } catch (err) {
    fail(
      `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}`,
      "BAD_DAEMON",
      2,
    )
  }

  try {
    let result: unknown
    switch (verb as ApiVerb) {
      case "spawn-task":
        result = await spawnTask(client, parsed)
        break
      case "fan-out":
        result = await fanOut(client, parsed)
        break
      case "send":
        result = await send(client, parsed)
        break
      case "get-task":
        result = await getTask(client, parsed)
        break
      case "collect":
        result = await collect(client, parsed)
        break
      case "list":
        result = await list(client)
        break
    }
    emit(result, parsed.pretty)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 1)
    fail(err instanceof Error ? err.message : String(err), "RPC_ERROR", 1)
  } finally {
    client.close()
  }
}

// Exported for tests.
export { ApiError }
