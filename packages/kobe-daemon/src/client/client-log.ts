/**
 * Client-side diagnostic log (the mirror of `daemon/crash-log.ts`).
 *
 * kobe's in-tmux panes (`kobe tasks`, `kobe ops`) and the front-end attach
 * run inside an opentui alternate-screen, so anything written to
 * stdout/stderr is painted over by the TUI and lost. That is exactly why
 * the Tasks-pane sync drift went undiagnosed: the pane logged
 * "daemon subscribe unavailable" / silently froze on a socket close, but no
 * human ever saw it. This module appends tagged, timestamped lines to a
 * real file (`<home>/.kobe/client.log`) so connection-lifecycle events —
 * subscribe, disconnect, reconnect attempts, fallbacks — leave a trace.
 *
 * Append-only + best-effort + NON-BLOCKING: a logging failure must NEVER
 * take down a pane, AND a log write must never stall the pane's event loop.
 * Some call sites are on the socket data handler (a guarded JSON-parse
 * failure) and the reconnect backoff loop, so the write is fire-and-forget
 * async `appendFile` (O_APPEND keeps each line atomic even with several pane
 * processes writing the same file) — never `appendFileSync`. Every error
 * path is swallowed so a stray rejection can't escape into a pane that has
 * no unhandled-rejection net.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { defaultClientLogPath } from "../daemon/paths.ts"

/**
 * A short label identifying WHICH client process a line came from — set
 * once per process at boot (`tasks`, `ops`, `settings`, `new-task`, `gui`).
 * Many panes append to the same file concurrently; the context + pid make
 * each line attributable.
 */
let context = "client"

/** Stamp every subsequent line with this process role. Call once at host boot. */
export function setClientLogContext(ctx: string): void {
  context = ctx
}

function coerceError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  let text: string
  try {
    text = typeof err === "string" ? err : JSON.stringify(err)
  } catch {
    text = String(err)
  }
  return { message: text }
}

/** Format one client-log line: ISO stamp, context, pid, subsystem, message. */
export function formatClientEntry(subsystem: string, message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] client ${context} [${subsystem}] pid=${process.pid}: ${message}\n`
}

let warnedOnce = false

function warnOnce(): void {
  if (warnedOnce) return
  warnedOnce = true
  try {
    process.stderr.write("[kobe] client log write failed; continuing without it\n")
  } catch {
    /* give up */
  }
}

// Serial write chain: each append links onto the previous one so a single
// process's lines stay in order (cross-process interleaving is still possible
// but O_APPEND keeps each LINE atomic). The caller never awaits it — the chain
// is fire-and-forget — but tests can flush it via {@link flushClientLog}.
let writeChain: Promise<void> = Promise.resolve()

/**
 * Queue a non-blocking append. Returns immediately; the write runs on the
 * chain and every failure is swallowed so nothing escapes into the caller.
 * On the first write of a fresh home the `.kobe/` dir may not exist yet — an
 * ENOENT triggers one mkdir + retry; any other failure warns once.
 */
function append(line: string): void {
  const path = defaultClientLogPath()
  writeChain = writeChain
    .then(async () => {
      try {
        await appendFile(path, line)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, line)
        } else {
          throw err
        }
      }
    })
    .catch(() => warnOnce())
}

/** Test-only: await all queued client-log writes (the fire-and-forget chain). */
export function flushClientLog(): Promise<void> {
  return writeChain
}

/** Record a tagged client info line (connect, subscribe, reconnect, fallback…). */
export function logClient(subsystem: string, message: string): void {
  append(formatClientEntry(subsystem, message))
}

/** Record a tagged client error line with the error's message + stack. */
export function logClientError(subsystem: string, err: unknown): void {
  const e = coerceError(err)
  append(formatClientEntry(subsystem, e.stack ?? e.message))
}
