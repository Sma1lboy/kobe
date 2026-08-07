/** Durable ChatTab -> current EngineRun pointers plus temporal run history. */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  EngineActivityKind,
  EngineRun,
  EngineSessionBinding,
  EngineSessionBindingsByTask,
  EngineSessionStartSource,
  VendorId,
} from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"

interface CurrentRunRef {
  readonly taskId: string
  readonly tabId: string
  readonly runId: string
}

interface SessionBindingsFileV2 {
  readonly version: 2
  readonly runs: EngineRun[]
  readonly currentRuns: CurrentRunRef[]
}

interface LoadedStore {
  readonly runs: EngineRun[]
  readonly currentRuns: CurrentRunRef[]
  readonly migrated: boolean
}

export interface BindSessionInput {
  readonly taskId: string
  readonly tabId: string
  readonly vendor: VendorId
  readonly sessionId: string
  readonly source: EngineSessionBinding["source"]
  readonly eventKind?: EngineActivityKind
  readonly startSource?: EngineSessionStartSource
  readonly transcriptPath?: string
  readonly state?: "bound" | "ended"
}

export function defaultSessionBindingsPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "session-bindings.json")
}

function bindingKey(value: Pick<EngineRun, "taskId" | "tabId">): string {
  return `${value.taskId}\0${value.tabId}`
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function validStartSource(value: unknown): value is EngineSessionStartSource {
  return value === "startup" || value === "resume" || value === "clear" || value === "compact"
}

function normalizeRun(value: unknown): EngineRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Partial<EngineRun>
  if (!nonEmpty(item.runId) || !nonEmpty(item.taskId) || !nonEmpty(item.tabId) || !nonEmpty(item.vendor)) {
    return null
  }
  if (item.sessionId !== null && !nonEmpty(item.sessionId)) return null
  if (!["pending", "bound", "ended", "superseded", "missing"].includes(item.state ?? "")) return null
  if (!["spawn", "observer", "hook", "history-recovery"].includes(item.source ?? "")) return null
  if (item.startSource !== undefined && !validStartSource(item.startSource)) return null
  if (!Number.isFinite(item.startedAt) || !Number.isFinite(item.updatedAt)) return null
  if (item.boundAt !== undefined && !Number.isFinite(item.boundAt)) return null
  if (item.endedAt !== undefined && !Number.isFinite(item.endedAt)) return null
  if (item.transcriptPath !== undefined && typeof item.transcriptPath !== "string") return null
  return {
    runId: item.runId,
    taskId: item.taskId,
    tabId: item.tabId,
    vendor: item.vendor,
    sessionId: item.sessionId,
    state: item.state as EngineRun["state"],
    source: item.source as EngineRun["source"],
    ...(item.startSource ? { startSource: item.startSource } : {}),
    ...(item.transcriptPath ? { transcriptPath: item.transcriptPath } : {}),
    startedAt: item.startedAt as number,
    ...(item.boundAt !== undefined ? { boundAt: item.boundAt } : {}),
    ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
    updatedAt: item.updatedAt as number,
  }
}

function migrateV1Binding(value: unknown): EngineRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  return normalizeRun({ ...item, runId: randomUUID() })
}

function normalizeCurrent(value: unknown, runs: ReadonlyMap<string, EngineRun>): CurrentRunRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Partial<CurrentRunRef>
  if (!nonEmpty(item.taskId) || !nonEmpty(item.tabId) || !nonEmpty(item.runId)) return null
  const run = runs.get(item.runId)
  return run && run.taskId === item.taskId && run.tabId === item.tabId
    ? { taskId: item.taskId, tabId: item.tabId, runId: item.runId }
    : null
}

async function readStore(path: string): Promise<LoadedStore> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    if (parsed.version === 2 && Array.isArray(parsed.runs) && Array.isArray(parsed.currentRuns)) {
      const runs = parsed.runs.map(normalizeRun).filter((run): run is EngineRun => run !== null)
      const byId = new Map(runs.map((run) => [run.runId, run]))
      const currentRuns = parsed.currentRuns
        .map((item) => normalizeCurrent(item, byId))
        .filter((item): item is CurrentRunRef => item !== null)
      return { runs, currentRuns, migrated: false }
    }
    if (parsed.version === 1 && Array.isArray(parsed.bindings)) {
      const runs = parsed.bindings.map(migrateV1Binding).filter((run): run is EngineRun => run !== null)
      return {
        runs,
        currentRuns: runs.map(({ taskId, tabId, runId }) => ({ taskId, tabId, runId })),
        migrated: true,
      }
    }
    return { runs: [], currentRuns: [], migrated: false }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], currentRuns: [], migrated: false }
    logDaemonError("session-bindings-load", err)
    return { runs: [], currentRuns: [], migrated: false }
  }
}

async function writeStore(
  path: string,
  runs: readonly EngineRun[],
  currentRuns: readonly CurrentRunRef[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const body: SessionBindingsFileV2 = { version: 2, runs: [...runs], currentRuns: [...currentRuns] }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export class SessionBindingStore {
  private readonly runs = new Map<string, EngineRun>()
  private readonly currentRunIds = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly bus: DaemonEventBus,
    private readonly now = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      const loaded = await readStore(this.path)
      this.runs.clear()
      this.currentRunIds.clear()
      for (const run of loaded.runs) this.runs.set(run.runId, run)
      for (const ref of loaded.currentRuns) this.currentRunIds.set(bindingKey(ref), ref.runId)
      if (loaded.migrated) await this.persist()
      this.publish()
    })
  }

  snapshotByTask(): EngineSessionBindingsByTask {
    const out: EngineSessionBindingsByTask = {}
    for (const run of this.currentRuns()) {
      const tabs = out[run.taskId] ?? {}
      tabs[run.tabId] = run
      out[run.taskId] = tabs
    }
    return out
  }

  runsSnapshot(): EngineRun[] {
    return [...this.runs.values()].sort(compareRuns)
  }

  /** Backward-compatible projection consumed by pre-run web clients. */
  sessionIdsByTask(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {}
    for (const run of this.currentRuns()) {
      if (!run.sessionId) continue
      const tabs = out[run.taskId] ?? {}
      tabs[run.tabId] = run.sessionId
      out[run.taskId] = tabs
    }
    return out
  }

  async begin(taskId: string, tabId: string, vendor: VendorId): Promise<EngineSessionBinding> {
    return await this.enqueue(async () => {
      const previous = this.currentRun({ taskId, tabId })
      // The PTY sidecar asks for engine-spec only when it is about to spawn a
      // process; socket reattach reuses the existing sidecar session. Mark the
      // run before spawn so a prompt supplied on argv cannot begin before the
      // run's time window. Duplicate begin calls while that spawn is pending
      // remain idempotent.
      if (previous?.vendor === vendor && previous.state === "pending") return previous
      const next = this.newRun({ taskId, tabId, vendor, source: "spawn" })
      await this.replaceCurrent(next, previous)
      return next
    })
  }

  async bind(input: BindSessionInput): Promise<EngineSessionBinding> {
    return await this.enqueue(async () => {
      const at = this.now()
      const current = this.currentRun(input)
      const fillsPending = current?.vendor === input.vendor && current.sessionId === null && current.state === "pending"
      const confirmsPinnedSpawn =
        current?.vendor === input.vendor &&
        current.sessionId === input.sessionId &&
        current.source === "spawn" &&
        current.startSource === undefined
      const confirmsObservedResume =
        current?.vendor === input.vendor &&
        current.sessionId === input.sessionId &&
        current.source === "observer" &&
        current.startSource === "resume" &&
        input.source === "hook" &&
        input.startSource === "resume"
      const startsRun = input.eventKind === "session-start" && input.startSource !== "compact"

      if (startsRun && !fillsPending && !confirmsPinnedSpawn && !confirmsObservedResume) {
        const next = this.boundRun(input, at)
        await this.replaceCurrent(next, current, at)
        return next
      }

      if (!current || current.vendor !== input.vendor || (current.sessionId && current.sessionId !== input.sessionId)) {
        // Any late event for a superseded run belongs to that historical run;
        // it must never steal the tab's current pointer back. A session id
        // never seen on this tab is still accepted for legacy reporters that
        // can miss SessionStart.
        const historical = this.latestMatchingRun(input)
        if (historical && historical.runId !== current?.runId) {
          const updated = this.updatedRun(historical, input, at)
          const retained = {
            ...updated,
            state: input.state === "ended" ? "ended" : historical.state,
          } satisfies EngineRun
          await this.commitRun(retained)
          return retained
        }
        const next = this.boundRun(input, at)
        await this.replaceCurrent(next, current, at)
        return next
      }

      const next = this.updatedRun(current, input, at)
      await this.commitRun(next)
      return next
    })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      let changed = false
      for (const [runId, run] of this.runs) {
        if (run.taskId !== taskId) continue
        this.runs.delete(runId)
        changed = true
      }
      for (const [key, runId] of this.currentRunIds) {
        if (this.runs.has(runId)) continue
        this.currentRunIds.delete(key)
      }
      if (changed) await this.commit()
    })
  }

  async deleteTaskBestEffort(taskId: string): Promise<void> {
    await this.deleteTask(taskId).catch((err) => logDaemonError("session-bindings-task-delete", err))
  }

  private currentRun(value: Pick<EngineRun, "taskId" | "tabId">): EngineRun | undefined {
    const runId = this.currentRunIds.get(bindingKey(value))
    return runId ? this.runs.get(runId) : undefined
  }

  private currentRuns(): EngineRun[] {
    return [...this.currentRunIds.values()]
      .map((runId) => this.runs.get(runId))
      .filter((run): run is EngineRun => run !== undefined)
      .sort(compareRuns)
  }

  private newRun(input: {
    taskId: string
    tabId: string
    vendor: VendorId
    source: EngineRun["source"]
  }): EngineRun {
    const at = this.now()
    return {
      runId: randomUUID(),
      ...input,
      sessionId: null,
      state: "pending",
      startedAt: at,
      updatedAt: at,
    }
  }

  private boundRun(input: BindSessionInput, at: number): EngineRun {
    return {
      runId: randomUUID(),
      taskId: input.taskId,
      tabId: input.tabId,
      vendor: input.vendor,
      sessionId: input.sessionId,
      state: input.state ?? "bound",
      source: input.source,
      ...(input.startSource ? { startSource: input.startSource } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      startedAt: at,
      boundAt: at,
      ...(input.state === "ended" ? { endedAt: at } : {}),
      updatedAt: at,
    }
  }

  private updatedRun(current: EngineRun, input: BindSessionInput, at: number): EngineRun {
    const startSource =
      input.startSource === "compact" ? current.startSource : (input.startSource ?? current.startSource)
    return {
      ...current,
      sessionId: input.sessionId,
      state: input.state ?? "bound",
      source: preferredSource(current.source, input.source),
      ...(startSource ? { startSource } : {}),
      ...((input.transcriptPath ?? current.transcriptPath)
        ? { transcriptPath: input.transcriptPath ?? current.transcriptPath }
        : {}),
      boundAt: current.boundAt ?? at,
      ...(input.state === "ended" ? { endedAt: current.endedAt ?? at } : {}),
      updatedAt: at,
    }
  }

  private latestMatchingRun(input: BindSessionInput): EngineRun | undefined {
    return this.runsSnapshot()
      .reverse()
      .find(
        (run) =>
          run.taskId === input.taskId &&
          run.tabId === input.tabId &&
          run.vendor === input.vendor &&
          run.sessionId === input.sessionId,
      )
  }

  private async replaceCurrent(next: EngineRun, previous?: EngineRun, at = next.startedAt): Promise<void> {
    if (previous && previous.runId !== next.runId) {
      this.runs.set(previous.runId, {
        ...previous,
        state: previous.state === "ended" ? "ended" : "superseded",
        endedAt: previous.endedAt ?? at,
        updatedAt: at,
      })
    }
    this.runs.set(next.runId, next)
    this.currentRunIds.set(bindingKey(next), next.runId)
    await this.commit()
  }

  private async commitRun(run: EngineRun): Promise<void> {
    this.runs.set(run.runId, run)
    await this.commit()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async commit(): Promise<void> {
    await this.persist()
    this.publish()
  }

  private async persist(): Promise<void> {
    const currentRuns = this.currentRuns().map(({ taskId, tabId, runId }) => ({ taskId, tabId, runId }))
    await writeStore(this.path, this.runsSnapshot(), currentRuns)
  }

  private publish(): void {
    this.bus.publish("session.bindings", { bindings: this.snapshotByTask() })
  }
}

function preferredSource(current: EngineRun["source"], incoming: EngineRun["source"]): EngineRun["source"] {
  const rank: Record<EngineRun["source"], number> = {
    spawn: 0,
    "history-recovery": 1,
    observer: 2,
    hook: 3,
  }
  return rank[incoming] >= rank[current] ? incoming : current
}

function compareRuns(a: EngineRun, b: EngineRun): number {
  return a.taskId.localeCompare(b.taskId) || a.tabId.localeCompare(b.tabId) || a.startedAt - b.startedAt
}
