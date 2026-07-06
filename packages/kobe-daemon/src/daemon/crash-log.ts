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

export function formatCrashEntry(
  kind: "uncaughtException" | "unhandledRejection",
  err: unknown,
  now: Date = new Date(),
): string {
  const e = toError(err)
  return `[${now.toISOString()}] daemon ${kind}: ${e.stack ?? `${e.name}: ${e.message}`}\n`
}

export function formatDaemonError(subsystem: string, err: unknown, now: Date = new Date()): string {
  const e = toError(err)
  return `[${now.toISOString()}] daemon error [${subsystem}]: ${e.stack ?? `${e.name}: ${e.message}`}\n`
}

export function logDaemonError(subsystem: string, err: unknown): void {
  process.stderr.write(formatDaemonError(subsystem, err))
}

export function formatDaemonInfo(subsystem: string, message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] daemon [${subsystem}]: ${message}\n`
}

export function logDaemonInfo(subsystem: string, message: string): void {
  process.stderr.write(formatDaemonInfo(subsystem, message))
}

let onRejection: ((reason: unknown) => void) | undefined
let onException: ((err: Error) => void) | undefined

export function installDaemonCrashHandlers(log: (line: string) => void = (l) => process.stderr.write(l)): void {
  if (onRejection || onException) return
  onRejection = (reason) => log(formatCrashEntry("unhandledRejection", reason))
  onException = (err) => log(formatCrashEntry("uncaughtException", err))
  process.on("unhandledRejection", onRejection)
  process.on("uncaughtException", onException)
}

export function resetDaemonCrashHandlersForTest(): void {
  if (onRejection) process.off("unhandledRejection", onRejection)
  if (onException) process.off("uncaughtException", onException)
  onRejection = undefined
  onException = undefined
}
