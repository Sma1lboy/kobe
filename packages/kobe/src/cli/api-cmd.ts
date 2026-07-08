/**
 * `kobe api <verb>` — the scriptable control surface for agents driving
 * kobe from a shell (Bash tool / cron / arbitrary scripts).
 *
 * Each invocation is a short-lived process: connect to (or auto-start) the
 * daemon, do the work, print a JSON object to stdout, exit. Designed for
 * fan-out AND full task lifecycle control — it exposes (almost) everything
 * the daemon can do, so an agent never has to drop into the TUI for a
 * scripted operation.
 *
 * ## Self-describing (so an agent can EXPLORE the surface)
 *
 * The verb table {@link VERBS} (`./api/verbs.ts`) is the single source of
 * truth: each entry binds one verb's spec (name, summary, flags) to its
 * handler, and the spec half drives the `schema` verb (machine-readable
 * JSON of every verb + flag, `./api/schema.ts`), per-verb `--help`, and
 * flag validation (required / enum / unknown-flag rejection, `./api/flags.ts`).
 * An agent runs `kobe api schema` once and knows the whole API — names,
 * types, which flags are required, allowed enum values — without parsing
 * prose. Add a verb to {@link VERBS} and its help, schema entry, and
 * validation all come for free.
 *
 * ## Handler seam (so verbs are unit-testable)
 *
 * Handlers (`./api/handlers-tasks.ts`, `./api/handlers-fanout.ts`) receive
 * a {@link VerbContext}: spec-typed flag access ({@link VerbArgs}, derived
 * from the verb's own FlagSpecs — no ad hoc re-validation inside handlers),
 * the narrow daemon RPC surface ({@link DaemonRpc} — a fake that records
 * requests stands in for the socket in tests), and the side-effect seam
 * ({@link ApiRuntime}, `./api/runtime.ts` — tmux / git / repo-init). Daemon
 * connect/close lives in `./daemon-session.ts`.
 *
 * ## Output contract
 *   - success → one JSON object to stdout, `\n` terminated, exit 0
 *   - error   → `{ "error": { "message", "code" } }` to stderr, exit ≠ 0
 *   - `--pretty` → indent stdout JSON (humans only)
 *   - `--help`   → render that verb's usage to stdout, exit 0
 *
 * The daemon is auto-started if it is not already running, so an agent
 * script does not have to babysit it (read-only verbs like `schema` skip
 * the daemon entirely).
 *
 * ## Module map (kept ≤500 lines each, this file is the dispatcher + barrel)
 *   - `./api/types.ts`            — shared types (FlagSpec, VerbContext, ApiRuntime, ...) + ApiError
 *   - `./api/flags.ts`            — flag parsing/validation + VerbArgs + fan-out plan helpers
 *   - `./api/schema.ts`           — `schema` verb + `--help` rendering
 *   - `./api/runtime.ts`          — prompt delivery + the default ApiRuntime
 *   - `./api/handler-helpers.ts`  — daemonOf / simpleRpc
 *   - `./api/handlers-tasks.ts`   — task CRUD + prompt-delivery handlers
 *   - `./api/handlers-fanout.ts`  — fan-out / collect / feedback handlers
 *   - `./api/verbs.ts`            — the VERBS table binding specs to handlers
 */

import { VerbArgs, buildCountPlan, parseAgentsSpec, parseFlags, validateAgainstSpec } from "./api/flags.ts"
import { defaultApiRuntime, deliverPrompt } from "./api/runtime.ts"
import { API_SCHEMA_VERSION, apiUsage, fullSchema, schemaIndex, verbHelp, verbSchema } from "./api/schema.ts"
import { ApiError } from "./api/types.ts"
import type {
  ApiRuntime,
  DeliveredPrompt,
  FlagSpec,
  Flags,
  ParsedArgs,
  PromptDeliveryOps,
  PromptTarget,
  VerbContext,
  VerbSpec,
} from "./api/types.ts"
import { API_VERBS, VERBS, VERB_GROUPS, findVerb } from "./api/verbs.ts"
import { type DaemonSession, openDaemonSession } from "./daemon-session.ts"
import type { DaemonRpc } from "./daemon-session.ts"

function emit(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  process.stdout.write(`${text}\n`)
}

function fail(message: string, code: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ error: { message, code } })}\n`)
  process.exit(exitCode)
}

function makeContext(verb: VerbSpec, flags: Flags, client: DaemonRpc | null, runtime: ApiRuntime): VerbContext {
  return { args: new VerbArgs(verb, flags), client, runtime }
}

/**
 * Parse + validate + run ONE verb against an injected client/runtime —
 * the unit-test (and embedding) entry. Throws {@link ApiError} instead of
 * exiting; `runApiSubcommand` keeps the process-exit/JSON-emit wrapper.
 */
export async function invokeVerb(
  verbName: string,
  argv: readonly string[],
  deps: { client: DaemonRpc | null; runtime?: ApiRuntime },
): Promise<unknown> {
  const verb = findVerb(verbName)
  if (!verb) throw new ApiError(`unknown verb: ${verbName}`, "BAD_VERB")
  const booleanFlags = new Set(verb.flags.filter((f) => f.type === "bool").map((f) => f.name))
  const parsed = parseFlags(argv, booleanFlags)
  validateAgainstSpec(verb, parsed.flags)
  return verb.handler(makeContext(verb, parsed.flags, deps.client, deps.runtime ?? defaultApiRuntime))
}

export async function runApiSubcommand(argv: readonly string[]): Promise<void> {
  const [verbName, ...rest] = argv
  if (!verbName || verbName === "--help" || verbName === "-h" || verbName === "help") {
    if (!verbName) fail(apiUsage(), "MISSING_VERB", 2)
    process.stdout.write(`${apiUsage()}\n`)
    return
  }
  const verb = findVerb(verbName)
  if (!verb) fail(`unknown verb: ${verbName}\n${apiUsage()}`, "BAD_VERB", 2)

  const booleanFlags = new Set(verb.flags.filter((f) => f.type === "bool").map((f) => f.name))
  let parsed: ParsedArgs
  try {
    parsed = parseFlags(rest, booleanFlags)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  if (parsed.help) {
    process.stdout.write(`${verbHelp(verb)}\n`)
    return
  }

  try {
    validateAgainstSpec(verb, parsed.flags)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  let session: DaemonSession | null = null
  if (!verb.offline) {
    try {
      session = await openDaemonSession()
    } catch (err) {
      fail(
        `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}`,
        "BAD_DAEMON",
        2,
      )
    }
  }

  try {
    const result = await verb.handler(makeContext(verb, parsed.flags, session?.client ?? null, defaultApiRuntime))
    emit(result, parsed.pretty)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 1)
    fail(err instanceof Error ? err.message : String(err), "RPC_ERROR", 1)
  } finally {
    session?.close()
  }
}

// Re-exported for tests + embedders — the historical single-file import
// path (`./api-cmd.ts`) stays the stable entry point across the split.
export {
  API_SCHEMA_VERSION,
  API_VERBS,
  ApiError,
  VERBS,
  VERB_GROUPS,
  VerbArgs,
  apiUsage,
  buildCountPlan,
  deliverPrompt,
  defaultApiRuntime,
  findVerb,
  parseAgentsSpec,
  parseFlags,
  validateAgainstSpec,
  verbHelp,
  schemaIndex,
  verbSchema,
  fullSchema,
}
export type { VerbSpec, FlagSpec, VerbContext, ApiRuntime, PromptDeliveryOps, PromptTarget, DeliveredPrompt }
