/**
 * Durable tab -> engine-session identities.
 *
 * The activity registry is intentionally transient; session identity is not.
 * A daemon restart must not make a still-running PTY forget which engine
 * transcript it owns, so this small versioned store lives beside tasks.json.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineSessionBinding, EngineSessionBindingsByTask, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"

interface SessionBindingsFile {
  readonly version: 1
  readonly bindings: EngineSessionBinding[]
}

export interface BindSessionInput {
  readonly taskId: string
  readonly tabId: string
  readonly vendor: VendorId
  readonly sessionId: string
  readonly source: EngineSessionBinding["source"]
  readonly transcriptPath?: string
  readonly state?: "bound" | "ended"
}

export function defaultSessionBindingsPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "session-bindings.json")
}

function bindingKey(value: Pick<EngineSessionBinding, "taskId" | "tabId">): string {
  return `${value.taskId}\0${value.tabId}`
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function normalizeBinding(value: unknown): EngineSessionBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Partial<EngineSessionBinding>
  if (!nonEmpty(item.taskId) || !nonEmpty(item.tabId) || !nonEmpty(item.vendor)) return null
  if (item.sessionId !== null && !nonEmpty(item.sessionId)) return null
  if (!["pending", "bound", "ended", "missing"].includes(item.state ?? "")) return null
  if (!["spawn", "hook", "history-recovery"].includes(item.source ?? "")) return null
  if (!Number.isFinite(item.startedAt) || !Number.isFinite(item.updatedAt)) return null
  if (item.boundAt !== undefined && !Number.isFinite(item.boundAt)) return null
  if (item.transcriptPath !== undefined && typeof item.transcriptPath !== "string") return null
  return {
    taskId: item.taskId,
    tabId: item.tabId,
    vendor: item.vendor,
    sessionId: item.sessionId,
    state: item.state as EngineSessionBinding["state"],
    source: item.source as EngineSessionBinding["source"],
    ...(item.transcriptPath ? { transcriptPath: item.transcriptPath } : {}),
    startedAt: item.startedAt as number,
    ...(item.boundAt !== undefined ? { boundAt: item.boundAt } : {}),
    updatedAt: item.updatedAt as number,
  }
}

async function readStore(path: string): Promise<EngineSessionBinding[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SessionBindingsFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return []
    return parsed.bindings.map(normalizeBinding).filter((binding): binding is EngineSessionBinding => binding !== null)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    logDaemonError("session-bindings-load", err)
    return []
  }
}

async function writeStore(path: string, bindings: readonly EngineSessionBinding[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const body: SessionBindingsFile = { version: 1, bindings: [...bindings] }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export class SessionBindingStore {
  private readonly bindings = new Map<string, EngineSessionBinding>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly bus: DaemonEventBus,
    private readonly now = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      this.bindings.clear()
      for (const binding of await readStore(this.path)) {
        this.bindings.set(bindingKey(binding), binding)
      }
      this.publish()
    })
  }

  snapshotByTask(): EngineSessionBindingsByTask {
    const out: EngineSessionBindingsByTask = {}
    for (const binding of this.sorted()) {
      const tabs = out[binding.taskId] ?? {}
      tabs[binding.tabId] = binding
      out[binding.taskId] = tabs
    }
    return out
  }

  /** Backward-compatible projection consumed by pre-binding web clients. */
  sessionIdsByTask(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {}
    for (const binding of this.bindings.values()) {
      if (!binding.sessionId) continue
      const tabs = out[binding.taskId] ?? {}
      tabs[binding.tabId] = binding.sessionId
      out[binding.taskId] = tabs
    }
    return out
  }

  async begin(taskId: string, tabId: string, vendor: VendorId): Promise<EngineSessionBinding> {
    return await this.enqueue(async () => {
      const previous = this.bindings.get(bindingKey({ taskId, tabId }))
      // `/api/engine-spec` is consulted for both a first spawn and a PTY
      // reattach. Re-reading the spec for a live same-vendor tab must not
      // erase its durable identity: the already-running engine will not emit
      // another session-start merely because a GUI reloaded. A real later
      // session-start still replaces the id in bind(); changing vendor starts
      // a genuinely new pending identity immediately.
      if (previous?.vendor === vendor) return previous
      const at = this.now()
      const next: EngineSessionBinding = {
        taskId,
        tabId,
        vendor,
        sessionId: null,
        state: "pending",
        source: "spawn",
        startedAt: at,
        updatedAt: at,
      }
      await this.commitWith(next)
      return next
    })
  }

  async bind(input: BindSessionInput): Promise<EngineSessionBinding> {
    return await this.enqueue(async () => {
      const at = this.now()
      const previous = this.bindings.get(bindingKey(input))
      const sameSpawn = previous?.sessionId === input.sessionId || previous?.sessionId === null
      const transcriptPath = input.transcriptPath ?? previous?.transcriptPath
      const next: EngineSessionBinding = {
        taskId: input.taskId,
        tabId: input.tabId,
        vendor: input.vendor,
        sessionId: input.sessionId,
        state: input.state ?? "bound",
        source: input.source,
        ...(transcriptPath ? { transcriptPath } : {}),
        startedAt: sameSpawn && previous ? previous.startedAt : at,
        boundAt: sameSpawn && previous?.boundAt ? previous.boundAt : at,
        updatedAt: at,
      }
      await this.commitWith(next)
      return next
    })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      const next = new Map(this.bindings)
      let changed = false
      for (const [key, binding] of next) {
        if (binding.taskId !== taskId) continue
        next.delete(key)
        changed = true
      }
      if (changed) await this.commit(next)
    })
  }

  async deleteTaskBestEffort(taskId: string): Promise<void> {
    await this.deleteTask(taskId).catch((err) => logDaemonError("session-bindings-task-delete", err))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async commitWith(binding: EngineSessionBinding): Promise<void> {
    const next = new Map(this.bindings)
    next.set(bindingKey(binding), binding)
    await this.commit(next)
  }

  private async commit(next: ReadonlyMap<string, EngineSessionBinding>): Promise<void> {
    const bindings = [...next.values()].sort(compareBindings)
    await writeStore(this.path, bindings)
    this.bindings.clear()
    for (const binding of bindings) this.bindings.set(bindingKey(binding), binding)
    this.publish()
  }

  private sorted(): EngineSessionBinding[] {
    return [...this.bindings.values()].sort(compareBindings)
  }

  private publish(): void {
    this.bus.publish("session.bindings", { bindings: this.snapshotByTask() })
  }
}

function compareBindings(a: EngineSessionBinding, b: EngineSessionBinding): number {
  return a.taskId.localeCompare(b.taskId) || a.tabId.localeCompare(b.tabId)
}
