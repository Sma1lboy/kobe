/**
 * Daemon crash resilience + diagnostics.
 *
 * The kobe daemon is a long-lived background process. It is spawned
 * detached with its stdout/stderr redirected to `~/.kobe/daemon.log`
 * (see `client/daemon-process.ts`). Two failure modes used to make it
 * "die easily":
 *
 *   1. **No crash net.** With no `process.on("unhandledRejection" /
 *      "uncaughtException")` handler registered, Node/Bun's default is
 *      to terminate the process. A single stray rejected promise from
 *      one of the daemon's many fire-and-forget `void someAsync()`
 *      calls (request pump, socket event handlers, timers, engine
 *      subprocess events) was enough to take the whole daemon down.
 *   2. **No trace.** Combined with the old `stdio: "ignore"` spawn, the
 *      crash produced zero output — the daemon just vanished.
 *
 * Registering these handlers flips the default: an unhandled rejection
 * or uncaught exception is *logged* (to stderr, hence into
 * `daemon.log`) and the daemon keeps serving. A long-lived RPC server
 * surviving a stray async error is the correct trade — each request is
 * independent, and a logged incident is far better than a silent death
 * mid-session. Genuinely fatal conditions (the event loop emptying,
 * SIGKILL) still end the process.
 */

/** Coerce an arbitrary thrown / rejected value into an Error so the
 *  log always has something stack-shaped to print. */
function toError(err: unknown): Error {
  if (err instanceof Error) return err
  let text: string
  try {
    text = typeof err === "string" ? err : JSON.stringify(err)
  } catch {
    text = String(err)
  }
  return new Error(text)
}

/** Render one crash-log line: ISO timestamp, kind, and full stack. */
export function formatCrashEntry(
  kind: "uncaughtException" | "unhandledRejection",
  err: unknown,
  now: Date = new Date(),
): string {
  const e = toError(err)
  return `[${now.toISOString()}] daemon ${kind}: ${e.stack ?? `${e.name}: ${e.message}`}\n`
}

/**
 * Render a daemon error line tagged with the subsystem that caught it.
 *
 * Crash handlers ({@link formatCrashEntry}) are the last-resort net —
 * they fire for whatever escaped, with no idea which part of the daemon
 * was at fault. A `subsystem` tag (`plan-usage-poller`, `rc-bridge`,
 * `daemon-shutdown`, …) attached at the catch site means a glance at
 * `daemon.log` points straight at the failing area instead of just a
 * raw stack.
 */
export function formatDaemonError(subsystem: string, err: unknown, now: Date = new Date()): string {
  const e = toError(err)
  return `[${now.toISOString()}] daemon error [${subsystem}]: ${e.stack ?? `${e.name}: ${e.message}`}\n`
}

/**
 * Log a tagged daemon error to stderr — captured in `daemon.log` once
 * the daemon is spawned with the log redirect. Use this in the `.catch`
 * of any fire-and-forget (`void someAsync()`) daemon call so a failure
 * is pinned to its subsystem rather than surfacing as an anonymous
 * `unhandledRejection`.
 */
export function logDaemonError(subsystem: string, err: unknown): void {
  process.stderr.write(formatDaemonError(subsystem, err))
}

/** Render a daemon INFO line (non-error lifecycle events). */
export function formatDaemonInfo(subsystem: string, message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] daemon [${subsystem}]: ${message}\n`
}

/**
 * Log a tagged daemon info line — captured in `daemon.log`. Use for the
 * connection lifecycle (subscribe / disconnect / idle-arm / idle-stop) so a
 * pane that silently desyncs can be correlated against the daemon's view of
 * the same socket churn. Distinct from {@link logDaemonError}, which is for
 * the `.catch` of a fire-and-forget; this is for expected events.
 */
export function logDaemonInfo(subsystem: string, message: string): void {
  process.stderr.write(formatDaemonInfo(subsystem, message))
}

let onRejection: ((reason: unknown) => void) | undefined
let onException: ((err: Error) => void) | undefined

/**
 * Install the daemon's `unhandledRejection` / `uncaughtException`
 * handlers. Call once, from the daemon process entry only — never from
 * code shared with the TUI or tests, since these mutate global
 * `process` state.
 *
 * `log` defaults to writing the formatted entry to stderr (captured in
 * `daemon.log`). Tests inject a capturing function instead.
 *
 * Idempotent: a second call is a no-op so a misbehaving caller can't
 * stack duplicate handlers.
 */
export function installDaemonCrashHandlers(log: (line: string) => void = (l) => process.stderr.write(l)): void {
  if (onRejection || onException) return
  onRejection = (reason) => log(formatCrashEntry("unhandledRejection", reason))
  onException = (err) => log(formatCrashEntry("uncaughtException", err))
  process.on("unhandledRejection", onRejection)
  process.on("uncaughtException", onException)
}

/**
 * Test-only: remove exactly the handlers this module installed (never
 * `removeAllListeners`, which would also strip the test runner's own
 * handlers) and clear the idempotency latch.
 */
export function resetDaemonCrashHandlersForTest(): void {
  if (onRejection) process.off("unhandledRejection", onRejection)
  if (onException) process.off("uncaughtException", onException)
  onRejection = undefined
  onException = undefined
}
