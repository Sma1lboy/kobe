/**
 * `kobe rpc <verb> [args]` — short-lived CLI that pokes a single RPC
 * at the running daemon and exits. Designed for tmux key-table chords
 * (see `src/tmux/keybindings.ts`) that fan out into daemon actions
 * without keeping a long-lived connection open.
 *
 * Surface (sprint-3):
 *   switch-task <id>
 *   switch-tab  <id|index>
 *   new-tab
 *   close-tab
 *   next-task
 *   prev-task
 *
 * Flags:
 *   --no-wait   fire-and-forget; do not block on the response, exit 0
 *               as soon as the request is written. tmux `run-shell`
 *               bindings use this so the chord doesn't stall the
 *               keyboard waiting on the daemon.
 *
 * Daemon-missing is a hard error (exit 2). The rpc handlers on the
 * daemon side (`rpc.switchTask`, …) are stubs for this sprint — they
 * acknowledge and log; sprint 4 wires them into real task/tab state.
 */

import { KobeDaemonClient } from "../client/index.ts"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"
import type { DaemonRequestName } from "../daemon/protocol.ts"

export interface ParsedRpcArgs {
  readonly verb: string
  readonly positional: readonly string[]
  readonly noWait: boolean
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/**
 * Parse argv after the `rpc` subcommand. Splits flags from positional
 * args; the only flag is `--no-wait` (boolean). Everything else is
 * a positional arg consumed by the verb router.
 */
export function parseRpcArgs(argv: readonly string[]): ParsedRpcArgs {
  if (argv.length === 0) throw new RpcError("missing verb", "MISSING_VERB")
  const positional: string[] = []
  let noWait = false
  let verb: string | undefined
  for (const arg of argv) {
    if (arg === "--no-wait") {
      noWait = true
      continue
    }
    if (arg.startsWith("--")) {
      throw new RpcError(`unknown flag: ${arg}`, "BAD_FLAG")
    }
    if (verb === undefined) {
      verb = arg
      continue
    }
    positional.push(arg)
  }
  if (verb === undefined) throw new RpcError("missing verb", "MISSING_VERB")
  return { verb, positional, noWait }
}

export interface RpcClient {
  connect(): Promise<void>
  request(name: DaemonRequestName, payload?: unknown): Promise<unknown>
  close(): void
}

export interface RouteResult {
  readonly name: DaemonRequestName
  readonly payload: Record<string, string>
}

/**
 * Map a verb + positional args to a daemon RPC name + payload. Pure —
 * does not touch the network. Throws RpcError for unknown verbs or
 * missing required args.
 */
export function routeVerb(verb: string, positional: readonly string[]): RouteResult {
  switch (verb) {
    case "switch-task": {
      const id = positional[0]
      if (!id) throw new RpcError("switch-task requires <id>", "MISSING_ARG")
      return { name: "rpc.switchTask", payload: { id } }
    }
    case "switch-tab": {
      const tabId = positional[0]
      if (!tabId) throw new RpcError("switch-tab requires <id|index>", "MISSING_ARG")
      return { name: "rpc.switchTab", payload: { tabId } }
    }
    case "new-task":
      return { name: "rpc.newTask", payload: {} }
    case "new-tab":
      return { name: "rpc.newTab", payload: {} }
    case "close-tab":
      return { name: "rpc.closeTab", payload: {} }
    case "next-task":
      return { name: "rpc.nextTask", payload: {} }
    case "prev-task":
      return { name: "rpc.prevTask", payload: {} }
    default:
      throw new RpcError(`unknown verb: ${verb}`, "BAD_VERB")
  }
}

export const RPC_VERBS = [
  "switch-task",
  "switch-tab",
  "new-task",
  "new-tab",
  "close-tab",
  "next-task",
  "prev-task",
] as const

export interface RunRpcOptions {
  /** Inject a fake client in tests. Defaults to a real KobeDaemonClient. */
  readonly clientFactory?: (socketPath: string) => RpcClient
  /** Override socket path. Defaults to `defaultDaemonSocketPath()`. */
  readonly socketPath?: string
  /** Capture stdout in tests instead of writing directly. */
  readonly stdout?: (line: string) => void
  /** Capture stderr in tests instead of writing directly. */
  readonly stderr?: (line: string) => void
}

export interface RunRpcResult {
  readonly exitCode: number
}

function emit(value: unknown, out: (line: string) => void): void {
  out(`${JSON.stringify(value)}\n`)
}

function fail(message: string, code: string, err: (line: string) => void, exitCode: number): RunRpcResult {
  err(`${JSON.stringify({ error: { message, code } })}\n`)
  return { exitCode }
}

/**
 * Pure-ish entry — given argv, drive a client, return an exit code.
 * Never calls `process.exit` directly so it stays testable. The thin
 * `runRpcSubcommand` wrapper below adapts it to the cli/index.ts shape.
 */
export async function runRpc(argv: readonly string[], options: RunRpcOptions = {}): Promise<RunRpcResult> {
  const stdout = options.stdout ?? ((line) => process.stdout.write(line))
  const stderr = options.stderr ?? ((line) => process.stderr.write(line))

  let parsed: ParsedRpcArgs
  try {
    parsed = parseRpcArgs(argv)
  } catch (e) {
    if (e instanceof RpcError) return fail(e.message, e.code, stderr, 2)
    return fail(e instanceof Error ? e.message : String(e), "BAD_FLAG", stderr, 2)
  }

  let route: RouteResult
  try {
    route = routeVerb(parsed.verb, parsed.positional)
  } catch (e) {
    if (e instanceof RpcError) return fail(e.message, e.code, stderr, 2)
    return fail(e instanceof Error ? e.message : String(e), "BAD_VERB", stderr, 2)
  }

  const socketPath = options.socketPath ?? defaultDaemonSocketPath()
  const client = (options.clientFactory ?? ((p) => new KobeDaemonClient(p) as RpcClient))(socketPath)

  try {
    try {
      await client.connect()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return fail(`no daemon at ${socketPath} (run \`kobe daemon start\`): ${msg}`, "BAD_DAEMON", stderr, 2)
    }

    if (parsed.noWait) {
      // Fire-and-forget: kick off the request but don't await it. We
      // still issue it (so the daemon sees the line) but don't let a
      // slow handler stall a tmux chord. close() lets the buffered
      // write flush.
      void client.request(route.name, route.payload).catch(() => {})
      emit({ ok: true, queued: true, name: route.name }, stdout)
      return { exitCode: 0 }
    }

    try {
      const result = await client.request(route.name, route.payload)
      emit(result, stdout)
      return { exitCode: 0 }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return fail(msg, "RPC_ERROR", stderr, 1)
    }
  } finally {
    client.close()
  }
}

/** CLI wrapper: call `runRpc(argv)` and translate the result into a
 *  process exit. Keeps `cli/index.ts` consistent with the other
 *  subcommands (which all return `void` and exit via process.exit). */
export async function runRpcSubcommand(argv: readonly string[]): Promise<void> {
  const { exitCode } = await runRpc(argv)
  if (exitCode !== 0) process.exit(exitCode)
}
