import type { VendorId } from "../../types/vendor"

export interface TabNamingTarget {
  readonly tabId: string
  readonly sessionId: string
  readonly vendor: VendorId
  readonly trigger: "poll" | "immediate"
  readonly retryDelaysMs?: readonly number[]
}

export interface TabNamingQueueDeps {
  readonly readTitle: (target: TabNamingTarget) => Promise<string>
  readonly isCurrent: (target: TabNamingTarget) => boolean
  readonly applyTitle: (target: TabNamingTarget, title: string) => void
  readonly maxConcurrent?: number
  readonly retryDelaysMs?: readonly number[]
}

interface NamingEntry {
  readonly targets: Map<string, TabNamingTarget>
  attempt: number
  state: "queued" | "running" | "waiting"
  timer?: ReturnType<typeof setTimeout>
  readonly retryDelaysMs: readonly number[]
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000, 5_000] as const

/**
 * Session-keyed, bounded queue for first-prompt tab naming.
 *
 * Repeated renders and OSC spinner frames collapse into one lookup per
 * session. Empty history retries with backoff because an engine can announce
 * its session id just before its first user message reaches disk.
 */
export class TabNamingQueue {
  private readonly entries = new Map<string, NamingEntry>()
  private readonly queuedKeys: string[] = []
  private readonly resolvedTitles = new Map<string, string>()
  private readonly maxConcurrent: number
  private readonly retryDelaysMs: readonly number[]
  private running = 0
  private generation = 0
  private stopped = false

  constructor(private readonly deps: TabNamingQueueDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 3)
    this.retryDelaysMs = deps.retryDelaysMs?.length ? deps.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS
  }

  enqueue(targets: readonly TabNamingTarget[]): void {
    if (this.stopped) return
    for (const target of targets) {
      if (!this.deps.isCurrent(target)) continue
      const key = this.key(target)
      const resolved = this.resolvedTitles.get(key)
      if (resolved) {
        this.deps.applyTitle(target, resolved)
        continue
      }
      const existing = this.entries.get(key)
      if (existing) {
        existing.targets.set(target.tabId, target)
        continue
      }
      this.entries.set(key, {
        targets: new Map([[target.tabId, target]]),
        attempt: 0,
        state: "queued",
        retryDelaysMs: target.retryDelaysMs?.length ? target.retryDelaysMs : this.retryDelaysMs,
      })
      this.queuedKeys.push(key)
    }
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.entries.clear()
    this.queuedKeys.length = 0
    this.resolvedTitles.clear()
    this.running = 0
  }

  private key(target: TabNamingTarget): string {
    return `${target.vendor}\0${target.sessionId}`
  }

  private prune(entry: NamingEntry): void {
    for (const [tabId, target] of entry.targets) {
      if (!this.deps.isCurrent(target)) entry.targets.delete(tabId)
    }
  }

  private pump(): void {
    while (!this.stopped && this.running < this.maxConcurrent) {
      const key = this.queuedKeys.shift()
      if (!key) return
      const entry = this.entries.get(key)
      if (!entry || entry.state !== "queued") continue
      this.prune(entry)
      const target = entry.targets.values().next().value as TabNamingTarget | undefined
      if (!target) {
        this.entries.delete(key)
        continue
      }
      entry.state = "running"
      this.running += 1
      const generation = this.generation
      void this.resolve(key, entry, target, generation)
    }
  }

  private async resolve(key: string, entry: NamingEntry, target: TabNamingTarget, generation: number): Promise<void> {
    let title = ""
    try {
      title = await this.deps.readTitle(target)
    } catch {
      // A rollout caught between creation and its first write is retryable.
    }
    if (this.stopped || generation !== this.generation || this.entries.get(key) !== entry) return

    this.running -= 1
    this.prune(entry)
    if (title) {
      this.resolvedTitles.set(key, title)
      this.entries.delete(key)
      for (const current of entry.targets.values()) this.deps.applyTitle(current, title)
    } else if (entry.targets.size === 0) {
      this.entries.delete(key)
    } else {
      const retryIndex = Math.min(entry.attempt, entry.retryDelaysMs.length - 1)
      const delay = entry.retryDelaysMs[retryIndex] ?? 5_000
      entry.attempt += 1
      entry.state = "waiting"
      entry.timer = setTimeout(() => {
        if (this.stopped || this.entries.get(key) !== entry) return
        entry.timer = undefined
        entry.state = "queued"
        this.queuedKeys.push(key)
        this.pump()
      }, delay)
    }
    this.pump()
  }
}
