import { createSignal } from "solid-js"
import { type PollScheduleState, maybeStartScheduledRun } from "../../lib/poll-scheduling.ts"

export {
  computeNextAllowedAt,
  shouldPoll,
  spawnCapture,
  type SpawnCaptureResult,
} from "../../lib/poll-scheduling.ts"

export interface BackgroundPollerConfig<T> {
  readonly run: (key: string, signal: AbortSignal) => Promise<T>
  readonly timeoutMs: number
  readonly slowRetryMs: number
  readonly minIntervalMs: number
  readonly equals?: (a: T, b: T) => boolean
  readonly initial: T
}

export interface BackgroundPoller<T> {
  read(key: string): T
  poll(key: string): void
  reset(): void
}

interface PollEntry<T> extends PollScheduleState {
  read: () => T
  write: (next: T) => void
}

export function createBackgroundPoller<T>(cfg: BackgroundPollerConfig<T>): BackgroundPoller<T> {
  const entries = new Map<string, PollEntry<T>>()

  function entryFor(key: string): PollEntry<T> {
    let entry = entries.get(key)
    if (!entry) {
      const [read, set] = createSignal<T>(cfg.initial, cfg.equals ? { equals: cfg.equals } : undefined)
      entry = { read, write: (next) => set(() => next), inFlight: false, nextAllowedAt: 0 }
      entries.set(key, entry)
    }
    return entry
  }

  return {
    read(key: string): T {
      if (!key) return cfg.initial
      return entryFor(key).read()
    },
    poll(key: string): void {
      if (!key) return
      const entry = entryFor(key)
      maybeStartScheduledRun(
        entry,
        cfg,
        (signal) => cfg.run(key, signal),
        (value) => entry.write(value),
      )
    },
    reset(): void {
      entries.clear()
    },
  }
}
