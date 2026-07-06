import { spawn } from "node:child_process"

export interface PollCadenceConfig {
  readonly timeoutMs: number
  readonly slowRetryMs: number
  readonly minIntervalMs: number
}

export interface PollScheduleState {
  inFlight: boolean
  nextAllowedAt: number
}

export function computeNextAllowedAt(
  startedAt: number,
  finishedAt: number,
  timedOut: boolean,
  cfg: { readonly slowRetryMs: number; readonly minIntervalMs: number },
): number {
  if (timedOut) return startedAt + cfg.slowRetryMs
  return finishedAt + Math.max(cfg.minIntervalMs, (finishedAt - startedAt) * 5)
}

export function shouldPoll(state: { inFlight: boolean; nextAllowedAt: number }, now: number): boolean {
  return !state.inFlight && now >= state.nextAllowedAt
}

export function applyJitter(delayMs: number, ratio: number, rand: () => number = Math.random): number {
  const r = Math.max(0, Math.min(1, ratio))
  const offset = (rand() * 2 - 1) * delayMs * r
  return Math.max(0, delayMs + offset)
}

export function exponentialBackoff(baseMs: number, attempt: number, capMs: number): number {
  if (attempt <= 0) return Math.min(baseMs, capMs)
  return Math.min(baseMs * 2 ** attempt, capMs)
}

export function maybeStartScheduledRun<T>(
  state: PollScheduleState,
  cfg: PollCadenceConfig,
  run: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
): boolean {
  const startedAt = Date.now()
  if (!shouldPoll(state, startedAt)) return false
  state.inFlight = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  void (async () => {
    let value: T | undefined
    let ok = false
    try {
      value = await run(controller.signal)
      ok = true
    } catch {}
    clearTimeout(timer)
    const timedOut = controller.signal.aborted
    state.nextAllowedAt = computeNextAllowedAt(startedAt, Date.now(), timedOut, cfg)
    state.inFlight = false
    if (ok && !timedOut) onValue(value as T)
  })()
  return true
}

export interface SpawnCaptureResult {
  readonly status: number | null
  readonly stdout: string
}

export function spawnCapture(
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly signal: AbortSignal },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    let out = ""
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: out })
    }
    const child = spawn(cmd, args.slice(), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env,
      signal: opts.signal,
      killSignal: "SIGKILL",
    })
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code))
  })
}
