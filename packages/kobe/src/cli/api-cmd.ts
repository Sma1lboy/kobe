/**
 * `kobe api <verb>` — scriptable RPC surface for agents driving kobe
 * from a shell (Bash tool / cron / arbitrary scripts).
 *
 * Each invocation is a short-lived process: open a Unix socket to the
 * running daemon, do one RPC, print a JSON object to stdout, exit.
 * Designed to replace the long-lived MCP bridge for the fan-out use
 * case ([`docs/design/cli-api.md`](../../../docs/design/cli-api.md)).
 *
 * Surface (v1 — 5 verbs):
 *   spawn-task   --repo PATH --prompt TEXT [--title T] [--base-branch B]
 *   create-tab   --task-id ID [--title T]
 *   send         --task-id ID --prompt TEXT [--tab-id TID]
 *   get-task     --task-id ID
 *   get-tab      --task-id ID --tab-id TID
 *
 * Output contract:
 *   - success → one JSON object to stdout, `\n` terminated, exit 0
 *   - error   → `{ "error": { "message", "code" } }` to stderr, exit ≠ 0
 *   - `--pretty` → indent stdout JSON (humans only)
 *
 * Daemon-missing is a hard error (exit 2 with code BAD_DAEMON). No
 * auto-start — the user is expected to have a daemon running, either
 * because the TUI is up or because they ran `kobe daemon start`.
 */

import { KobeDaemonClient } from "../client/index.ts"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"

type Flags = Map<string, string>

interface ParsedArgs {
  readonly flags: Flags
  readonly pretty: boolean
}

/**
 * Parse argv into a flag map + `--pretty` boolean.
 *
 * Accepts both `--key=value` and `--key value`. Boolean flags
 * (currently only `--pretty`) take no value. Unknown forms throw a
 * BAD_FLAG error.
 */
function parseFlags(argv: readonly string[]): ParsedArgs {
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
        // `--pretty=true|false` is mostly a footgun, but support it.
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

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
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

/** Write the success payload to stdout. Always `\n`-terminated. */
function emit(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  process.stdout.write(`${text}\n`)
}

/**
 * Write `{error: {message, code}}` to stderr and exit non-zero. Stderr
 * is used so `kobe api … | jq` doesn't choke on error text.
 */
function fail(message: string, code: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ error: { message, code } })}\n`)
  process.exit(exitCode)
}

async function spawnTask(client: KobeDaemonClient, flags: Flags): Promise<unknown> {
  const payload: Record<string, string> = {
    repo: required(flags, "repo"),
    prompt: required(flags, "prompt"),
  }
  const title = optional(flags, "title")
  if (title) payload.title = title
  const baseRef = optional(flags, "base-branch")
  if (baseRef) payload.baseRef = baseRef
  return client.request("task.spawn", payload)
}

async function createTab(client: KobeDaemonClient, flags: Flags): Promise<unknown> {
  const payload: Record<string, string> = {
    taskId: required(flags, "task-id"),
  }
  const title = optional(flags, "title")
  if (title) payload.title = title
  return client.request("chat.tab.create", payload)
}

async function send(client: KobeDaemonClient, flags: Flags): Promise<unknown> {
  const payload: Record<string, string> = {
    taskId: required(flags, "task-id"),
    text: required(flags, "prompt"),
  }
  const tabId = optional(flags, "tab-id")
  if (tabId) payload.tabId = tabId
  await client.request("chat.send", payload)
  // chat.send returns {} or {pending: ...} — normalize so the agent
  // sees a consistent shape across success/queued paths.
  return { ok: true }
}

async function getTask(client: KobeDaemonClient, flags: Flags): Promise<unknown> {
  const taskId = required(flags, "task-id")
  return client.request("task.get", { taskId })
}

interface TaskGetResponse {
  readonly task: { readonly tabs?: ReadonlyArray<{ readonly id: string }> }
}

async function getTab(client: KobeDaemonClient, flags: Flags): Promise<unknown> {
  const taskId = required(flags, "task-id")
  const tabId = required(flags, "tab-id")
  const res = (await client.request("task.get", { taskId })) as TaskGetResponse
  const tab = res.task?.tabs?.find((t) => t.id === tabId)
  if (!tab) {
    throw new ApiError(`tab not found: task=${taskId} tab=${tabId}`, "TAB_NOT_FOUND")
  }
  return { tab }
}

export async function runApiSubcommand(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv
  if (!verb) {
    fail(
      "usage: kobe api <spawn-task|create-tab|send|get-task|get-tab> [flags] [--pretty]",
      "MISSING_VERB",
      2,
    )
  }

  let parsed: ParsedArgs
  try {
    parsed = parseFlags(rest)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  const client = new KobeDaemonClient(defaultDaemonSocketPath())
  try {
    try {
      await client.connect()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fail(`no daemon at ${defaultDaemonSocketPath()} (run \`kobe daemon start\`): ${msg}`, "BAD_DAEMON", 2)
    }

    try {
      let result: unknown
      switch (verb) {
        case "spawn-task":
          result = await spawnTask(client, parsed.flags)
          break
        case "create-tab":
          result = await createTab(client, parsed.flags)
          break
        case "send":
          result = await send(client, parsed.flags)
          break
        case "get-task":
          result = await getTask(client, parsed.flags)
          break
        case "get-tab":
          result = await getTab(client, parsed.flags)
          break
        default:
          fail(`unknown verb: ${verb}`, "BAD_VERB", 2)
      }
      emit(result, parsed.pretty)
    } catch (err) {
      if (err instanceof ApiError) fail(err.message, err.code, 1)
      fail(err instanceof Error ? err.message : String(err), "RPC_ERROR", 1)
    }
  } finally {
    client.close()
  }
}

// Exported for tests.
export { parseFlags, ApiError }
