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
 * Surface (v0.6 — 4 verbs):
 *   spawn-task   --repo PATH [--prompt TEXT] [--title T] [--base-branch B] [--vendor V]
 *   send         [--task-id ID] --prompt TEXT
 *   get-task     --task-id ID
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

import { connectOrStartDaemon } from "../client/daemon-process.ts"
import type { KobeDaemonClient } from "../client/index.ts"
import type { SerializedTask } from "../daemon/protocol.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import {
  capturePaneById,
  claudePaneId,
  claudePaneIdStrict,
  runTmux,
  sendKeyName,
  sessionExists,
  tmuxSessionName,
} from "../tmux/client.ts"
import { ALL_VENDORS, type VendorId } from "../types/vendor.ts"

/** Verbs this command accepts, in help order. */
export const API_VERBS = ["spawn-task", "send", "get-task", "list"] as const
export type ApiVerb = (typeof API_VERBS)[number]

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

/** One-line usage banner for `kobe api` with no/bad verb. */
export function apiUsage(): string {
  return [
    "usage: kobe api <verb> [flags] [--pretty]",
    "",
    "verbs:",
    "  spawn-task  --repo PATH [--prompt TEXT] [--title T] [--base-branch B] [--vendor V]",
    "  send        [--task-id ID] --prompt TEXT",
    "  get-task    --task-id ID",
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Task metadata needed to find/build a session and its engine pane. */
interface PromptTarget {
  readonly id: string
  readonly worktreePath: string
  readonly vendor?: VendorId
}

/**
 * Wait for a session's engine (claude/codex) pane to be ready for input.
 *
 * The engine pane is tagged `@kobe_role=claude` at session-BUILD time —
 * before the engine process boots — so a tagged pane is NOT proof the
 * REPL can accept input yet; sending keystrokes too early drops them. For
 * a fresh session we therefore treat the pane as ready only once its
 * captured text is non-empty AND stable across two polls (~250ms apart):
 * a quiesced pane means the input box is painted, not still repainting on
 * boot. An already-running session's engine is ready immediately.
 *
 * `ready` is `false` when the budget is exhausted without confirmation —
 * the caller still delivers best-effort but surfaces that to the script,
 * so a cold-boot drop never looks like a clean success.
 */
async function waitForEnginePane(session: string, fresh: boolean): Promise<{ pane: string; ready: boolean }> {
  let prev: string | null = null
  for (let attempt = 0; attempt < 24; attempt++) {
    const pane = await claudePaneIdStrict(session)
    if (pane) {
      if (!fresh) return { pane, ready: true }
      const cur = (await capturePaneById(pane)).trim()
      if (cur.length > 0 && cur === prev) return { pane, ready: true }
      prev = cur
    }
    await sleep(250)
  }
  // Budget exhausted: deliver to the tagged pane (or first-pane fallback
  // for a legacy/pre-tag session), but report the engine never confirmed.
  const pane = (await claudePaneIdStrict(session)) || (await claudePaneId(session))
  return { pane, ready: false }
}

/**
 * Type a (possibly multi-line) prompt into a pane and submit it.
 *
 * Uses a tmux paste buffer with bracketed-paste markers (`-p`) so an
 * interactive REPL receives the whole block as ONE paste. Plain
 * `send-keys -l` would type the bytes verbatim, and an embedded newline
 * is Enter to claude/codex — so a multi-paragraph prompt would submit at
 * the first line break. With bracketed paste the engine inserts the
 * entire block into its composer; a single trailing Enter then submits.
 */
async function pasteAndSubmit(pane: string, text: string): Promise<void> {
  const buffer = `kobe-api-${pane.replace(/[^A-Za-z0-9]/g, "")}`
  await runTmux(["set-buffer", "-b", buffer, "--", text])
  await runTmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane])
  await sendKeyName(pane, "Enter")
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
    const ok = await ensureSession({
      name: session,
      cwd: worktree,
      command: interactiveEngineCommand(target.vendor),
      taskId: target.id,
      vendor: target.vendor,
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
    { id: res.taskId, worktreePath: res.task.worktreePath, vendor: res.task.vendor as VendorId | undefined },
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
    { id: taskId, worktreePath: res.task.worktreePath, vendor: res.task.vendor as VendorId | undefined },
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
      case "send":
        result = await send(client, parsed)
        break
      case "get-task":
        result = await getTask(client, parsed)
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
