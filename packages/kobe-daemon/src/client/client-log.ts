import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { defaultClientLogPath } from "../daemon/paths.ts"

let context = "client"

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

export function formatClientEntry(subsystem: string, message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] client ${context} [${subsystem}] pid=${process.pid}: ${message}\n`
}

let warnedOnce = false

function warnOnce(): void {
  if (warnedOnce) return
  warnedOnce = true
  try {
    process.stderr.write("[kobe] client log write failed; continuing without it\n")
  } catch {}
}

let writeChain: Promise<void> = Promise.resolve()

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

export function flushClientLog(): Promise<void> {
  return writeChain
}

export function logClient(subsystem: string, message: string): void {
  append(formatClientEntry(subsystem, message))
}

export function logClientError(subsystem: string, err: unknown): void {
  const e = coerceError(err)
  append(formatClientEntry(subsystem, e.stack ?? e.message))
}

let onRejection: ((reason: unknown) => void) | undefined
let onException: ((err: Error) => void) | undefined

export function installClientCrashHandlers(): void {
  if (onRejection || onException) return
  onRejection = (reason) => logClientError("crash-net", reason)
  onException = (err) => logClientError("crash-net", err)
  process.on("unhandledRejection", onRejection)
  process.on("uncaughtException", onException)
}

export function resetClientCrashHandlersForTest(): void {
  if (onRejection) process.off("unhandledRejection", onRejection)
  if (onException) process.off("uncaughtException", onException)
  onRejection = undefined
  onException = undefined
}
