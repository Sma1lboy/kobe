/**
 * `kobe hook <verb> --task-id <id>` — INTERNAL subcommand fired by an engine's
 * hooks (e.g. Claude Code's Stop / StopFailure / Notification), installed into
 * a task's worktree by the engine hook adapter. It reports a NORMALIZED
 * activity event to the daemon, which folds it into the task's transient
 * engine-state and broadcasts it (event-driven task badges).
 *
 * Contract (load-bearing):
 *  - **Never spawns the daemon.** A hook may fire while the user is detached
 *    (no gui) and the daemon has idle-stopped; resurrecting a gui-less daemon
 *    would break the refcounted lazy-shutdown. If no daemon is running the
 *    event is simply dropped (best-effort; the activity badge lapses to idle
 *    and the polling fallback still covers it).
 *  - **Always exits 0.** A non-zero hook exit is at best logged and at worst
 *    (WorktreeCreate) FAILS the engine's action — never acceptable for an
 *    observability hook. Every failure path here is swallowed.
 *
 * `verb` is already vendor-neutral (the engine adapter did the translation);
 * extra detail (failure class, waiting reason) is read from the hook's stdin
 * JSON payload.
 */

import { connectIfRunning } from "../client/daemon-process.ts"
import type { EngineActivityDetail } from "../engine/hook-events.ts"
import { isEngineActivityKind } from "../engine/hook-events.ts"

/** Read the hook's stdin JSON payload (Claude Code pipes it), bounded so a
 *  manual invocation without stdin can't hang. Returns {} on anything odd. */
async function readStdinPayload(): Promise<Record<string, unknown>> {
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 500)),
    ])
    if (!text.trim()) return {}
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Map a Claude StopFailure `error_type` to the neutral failure class. */
function failureFromErrorType(errorType: unknown): EngineActivityDetail["failure"] {
  if (typeof errorType !== "string") return "other"
  if (errorType === "rate_limit" || errorType === "overloaded") return "rate_limit"
  if (errorType === "billing_error") return "billing"
  return "other"
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

export async function runHookSubcommand(argv: readonly string[]): Promise<void> {
  // Everything is best-effort + always exit 0 (see header).
  try {
    const [verb, ...rest] = argv
    if (!verb || !isEngineActivityKind(verb)) return // unknown verb → drop silently
    const taskId = flagValue(rest, "--task-id")
    if (!taskId) return

    const payload = await readStdinPayload()
    let detail: EngineActivityDetail | undefined
    if (verb === "turn-failed") {
      detail = { failure: failureFromErrorType(payload.error_type) }
    } else if (verb === "awaiting-input") {
      // The only awaiting-input hook kobe installs is the permission matcher.
      detail = { waiting: "permission" }
    }

    const client = await connectIfRunning() // NON-spawning by contract
    if (!client) return
    try {
      await client.request("engine.reportEvent", { taskId, kind: verb, ...(detail ? { detail } : {}) })
    } finally {
      client.close()
    }
  } catch {
    /* swallow — hooks must never fail the engine */
  }
}
