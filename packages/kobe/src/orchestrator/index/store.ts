import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Task, TaskId, TaskIndex, TaskPRStatus, TaskStatus } from "../../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../../types/task.ts"
import { coerceVendorId } from "../../types/vendor.ts"
import { LockfileError, acquire, release } from "./lockfile.ts"
import { ulid } from "./ulid.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const LOCK_RETRY_DELAY_MS = 25
const LOCK_MAX_WAIT_MS = 5_000

async function acquireWithRetry(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      await acquire(lockPath)
      return
    } catch (err) {
      if (!(err instanceof LockfileError) || Date.now() >= deadline) throw err
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }
}

export interface TaskIndexStoreOptions {
  readonly homeDir?: string
}

export type TaskCreateInput = Omit<Task, "id" | "createdAt" | "updatedAt" | "archived"> & {
  readonly archived?: boolean
}

const CURRENT_VERSION = 3 as const
const EMPTY_INDEX: TaskIndex = { version: CURRENT_VERSION, tasks: [] } as const
void EMPTY_INDEX

export type TaskIndexListener = (snapshot: readonly Task[]) => void
export type TaskIndexUnsubscribe = () => void

export class TaskIndexStore {
  private readonly homeDir: string
  private readonly kobeDir: string
  private readonly path: string
  private readonly tmpPath: string
  private readonly lockPath: string
  private cache: { version: typeof CURRENT_VERSION; tasks: Task[] } = { version: CURRENT_VERSION, tasks: [] }
  private loaded = false
  private listeners = new Set<TaskIndexListener>()
  private saveChain: Promise<void> = Promise.resolve()
  private readonly dirtyIds = new Set<string>()
  private readonly removedIds = new Set<string>()

  constructor(options: TaskIndexStoreOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
    this.kobeDir = join(this.homeDir, ".kobe")
    this.path = join(this.kobeDir, "tasks.json")
    this.tmpPath = `${this.path}.tmp`
    this.lockPath = `${this.path}.lock`
  }

  subscribe(listener: TaskIndexListener): TaskIndexUnsubscribe {
    this.listeners.add(listener)
    if (this.loaded) {
      try {
        listener(this.cache.tasks.slice())
      } catch (err) {
        console.error("[kobe TaskIndexStore] listener threw on subscribe:", err)
      }
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  get filePath(): string {
    return this.path
  }

  get stateDir(): string {
    return this.kobeDir
  }

  async load(): Promise<TaskIndex> {
    this.dirtyIds.clear()
    this.removedIds.clear()
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        this.cache = { version: CURRENT_VERSION, tasks: [] }
        this.loaded = true
        this.notifyListeners()
        return this.snapshot()
      }
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(
        `[kobe] tasks.json at ${this.path} is corrupted (${(err as Error).message}); recovering with empty index. The stale file is left in place.`,
      )
      this.cache = { version: CURRENT_VERSION, tasks: [] }
      this.loaded = true
      this.notifyListeners()
      return this.snapshot()
    }

    this.cache = normalizeIndex(parsed, this.path)
    this.loaded = true
    this.notifyListeners()
    return this.snapshot()
  }

  async save(): Promise<void> {
    this.assertLoaded()
    const next = this.saveChain.then(() => this.doSave())
    this.saveChain = next.catch(() => {})
    return next
  }

  private async doSave(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })

    const dirty = new Set(this.dirtyIds)
    const removed = new Set(this.removedIds)

    await acquireWithRetry(this.lockPath)
    try {
      const diskTasks = await this.readDiskTasks()
      const mergedTasks = this.mergeWithDisk(diskTasks, dirty, removed)
      const payload: TaskIndex = { version: CURRENT_VERSION, tasks: mergedTasks }
      const json = `${JSON.stringify(payload, null, 2)}\n`

      const handle = await open(this.tmpPath, "w", 0o644)
      try {
        await handle.writeFile(json, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(this.tmpPath, this.path)

      for (const id of dirty) this.dirtyIds.delete(id)
      for (const id of removed) this.removedIds.delete(id)

      const present = new Set(this.cache.tasks.map((t) => t.id))
      for (const task of mergedTasks) {
        if (!present.has(task.id)) this.cache.tasks.push(task)
      }
    } finally {
      await release(this.lockPath)
    }
  }

  private async readDiskTasks(): Promise<Task[]> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    return normalizeIndex(parsed, this.path).tasks
  }

  private mergeWithDisk(diskTasks: Task[], dirty: ReadonlySet<string>, removed: ReadonlySet<string>): Task[] {
    const diskById = new Map(diskTasks.map((t) => [t.id, t] as const))
    const result: Task[] = []
    const included = new Set<string>()

    for (const task of this.cache.tasks) {
      if (dirty.has(task.id)) {
        result.push(task)
      } else {
        const onDisk = diskById.get(task.id)
        if (onDisk === undefined) continue
        result.push(onDisk)
      }
      included.add(task.id)
    }

    for (const task of diskTasks) {
      if (included.has(task.id) || removed.has(task.id)) continue
      result.push(task)
      included.add(task.id)
    }

    return result
  }

  get(id: TaskId | string): Task | undefined {
    this.assertLoaded()
    return this.cache.tasks.find((t) => t.id === id)
  }

  list(): Task[] {
    this.assertLoaded()
    return this.cache.tasks.slice()
  }

  async create(partial: TaskCreateInput): Promise<Task> {
    this.assertLoaded()
    const now = new Date().toISOString()
    const task: Task = {
      archived: false,
      vendor: partial.vendor ?? DEFAULT_TASK_VENDOR,
      ...partial,
      id: toTaskId(ulid()),
      createdAt: now,
      updatedAt: now,
    }
    this.cache.tasks.push(task)
    this.dirtyIds.add(task.id)
    await this.save()
    this.notifyListeners()
    return task
  }

  async update(id: TaskId | string, patch: Partial<Task>): Promise<Task> {
    this.assertLoaded()
    const idx = this.cache.tasks.findIndex((t) => t.id === id)
    if (idx < 0) throw new Error(`task not found: ${id}`)
    const existing = this.cache.tasks[idx]
    if (!existing) throw new Error(`task not found: ${id}`)

    const { id: _id, createdAt: _createdAt, ...mutable } = patch
    void _id
    void _createdAt

    const next: Task = {
      ...existing,
      ...mutable,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.cache.tasks[idx] = next
    this.dirtyIds.add(String(id))
    await this.save()
    this.notifyListeners()
    return next
  }

  async move(id: TaskId | string, delta: -1 | 1, withinIds?: readonly string[]): Promise<Task> {
    this.assertLoaded()
    const task = this.cache.tasks.find((t) => t.id === id)
    if (!task) throw new Error(`task not found: ${id}`)
    const ids = withinIds?.length ? withinIds : this.cache.tasks.map((t) => t.id)
    const pos = ids.indexOf(String(id))
    if (pos < 0) throw new Error(`task not movable in current group: ${id}`)
    const targetId = ids[pos + delta]
    if (!targetId) return task

    const fromIdx = this.cache.tasks.findIndex((t) => t.id === id)
    const toIdx = this.cache.tasks.findIndex((t) => t.id === targetId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return task

    const [moved] = this.cache.tasks.splice(fromIdx, 1)
    if (!moved) return task
    const adjustedToIdx = fromIdx < toIdx ? toIdx - 1 : toIdx
    const insertAt = delta > 0 ? adjustedToIdx + 1 : adjustedToIdx
    const next: Task = { ...moved, updatedAt: new Date().toISOString() }
    this.cache.tasks.splice(insertAt, 0, next)
    this.dirtyIds.add(String(id))
    await this.save()
    this.notifyListeners()
    return next
  }

  async reorder(moves: ReadonlyArray<{ readonly id: TaskId | string; readonly position: number }>): Promise<void> {
    this.assertLoaded()
    const resolved = moves.map((move) => {
      const idx = this.cache.tasks.findIndex((t) => t.id === move.id)
      const existing = idx >= 0 ? this.cache.tasks[idx] : undefined
      if (!existing) throw new Error(`task not found: ${move.id}`)
      return { idx, position: move.position }
    })
    let dirty = false
    const before = new Map<number, Task>()
    const markedDirty: string[] = []
    for (const { idx, position } of resolved) {
      const existing = this.cache.tasks[idx]
      if (!existing || existing.position === position) continue
      if (!before.has(idx)) before.set(idx, existing)
      this.cache.tasks[idx] = { ...existing, position }
      if (!this.dirtyIds.has(existing.id)) {
        this.dirtyIds.add(existing.id)
        markedDirty.push(existing.id)
      }
      dirty = true
    }
    if (!dirty) return
    try {
      await this.save()
    } catch (err) {
      for (const [idx, task] of before) this.cache.tasks[idx] = task
      for (const id of markedDirty) this.dirtyIds.delete(id)
      throw err
    }
    this.notifyListeners()
  }

  async archive(id: TaskId | string, status: TaskStatus = "done"): Promise<Task> {
    return this.update(id, { status })
  }

  async remove(id: TaskId | string): Promise<void> {
    this.assertLoaded()
    const idx = this.cache.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return
    this.cache.tasks.splice(idx, 1)
    this.dirtyIds.delete(String(id))
    this.removedIds.add(String(id))
    await this.save()
    this.notifyListeners()
  }

  async _unlinkForTests(): Promise<void> {
    try {
      await unlink(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    try {
      await unlink(this.tmpPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    this.cache = { version: CURRENT_VERSION, tasks: [] }
    this.loaded = false
    this.dirtyIds.clear()
    this.removedIds.clear()
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("TaskIndexStore: call load() before any other method")
    }
  }

  private snapshot(): TaskIndex {
    return {
      version: CURRENT_VERSION,
      tasks: this.cache.tasks.slice(),
    }
  }

  private notifyListeners(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.cache.tasks.slice()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error("[kobe TaskIndexStore] listener threw on notify:", err)
      }
    }
  }
}

function normalizeIndex(parsed: unknown, source: string): { version: typeof CURRENT_VERSION; tasks: Task[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[kobe] tasks.json at ${source} is not an object; recovering with empty index.`)
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const obj = parsed as { version?: unknown; tasks?: unknown }
  const version = obj.version
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    console.warn(
      `[kobe] tasks.json at ${source} has unsupported version=${String(version)}; recovering with empty index.`,
    )
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks: Task[] = []
  for (const entry of rawTasks) {
    const task = coerceTask(entry)
    if (task) tasks.push(task)
    else {
      console.warn(`[kobe] dropping malformed task entry from ${source}: ${JSON.stringify(entry)}`)
    }
  }
  return { version: CURRENT_VERSION, tasks }
}

function coerceTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (
    typeof v.id !== "string" ||
    typeof v.title !== "string" ||
    typeof v.repo !== "string" ||
    typeof v.branch !== "string" ||
    typeof v.worktreePath !== "string" ||
    typeof v.status !== "string" ||
    typeof v.createdAt !== "string" ||
    typeof v.updatedAt !== "string"
  ) {
    return null
  }
  if (!isTaskStatus(v.status)) return null

  const archived = typeof v.archived === "boolean" ? v.archived : false
  const kind: Task["kind"] = v.kind === "main" ? "main" : "task"
  const healedStatus: TaskStatus =
    kind === "main"
      ? v.status === "in_progress" || v.status === "done"
        ? "backlog"
        : v.status
      : v.status === "done" && !archived
        ? "in_progress"
        : v.status

  return {
    id: toTaskId(v.id),
    title: v.title,
    repo: v.repo,
    branch: v.branch,
    worktreePath: v.worktreePath,
    status: healedStatus,
    archived,
    pinned: typeof v.pinned === "boolean" ? v.pinned : false,
    kind,
    vendor: coerceVendorId(typeof v.vendor === "string" ? v.vendor : undefined),
    prStatus: coercePRStatus(v.prStatus),
    ...(typeof v.position === "number" && Number.isFinite(v.position) ? { position: v.position } : {}),
    ...(typeof v.modelEffort === "string" && v.modelEffort.length > 0 ? { modelEffort: v.modelEffort } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

function coercePRStatus(value: unknown): TaskPRStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (!isPRProviderId(v.provider) || !isPRLifecycleState(v.lifecycle) || !isPRCheckState(v.checkState)) {
    return undefined
  }
  return {
    provider: v.provider,
    lifecycle: v.lifecycle,
    checkState: v.checkState,
    ...(typeof v.number === "number" && Number.isFinite(v.number) ? { number: v.number } : {}),
    ...(typeof v.url === "string" ? { url: v.url } : {}),
    ...(typeof v.title === "string" ? { title: v.title } : {}),
    ...(typeof v.baseRef === "string" ? { baseRef: v.baseRef } : {}),
    ...(typeof v.headRef === "string" ? { headRef: v.headRef } : {}),
    ...(typeof v.reviewDecision === "string" ? { reviewDecision: v.reviewDecision } : {}),
    ...(typeof v.mergeable === "string" ? { mergeable: v.mergeable } : {}),
    ...(typeof v.lastCheckedAt === "string" ? { lastCheckedAt: v.lastCheckedAt } : {}),
    ...(typeof v.lastError === "string" ? { lastError: v.lastError } : {}),
  }
}

function isPRProviderId(v: unknown): v is TaskPRStatus["provider"] {
  return v === "github" || v === "gitlab" || v === "bitbucket" || v === "unknown"
}

function isPRLifecycleState(v: unknown): v is TaskPRStatus["lifecycle"] {
  return (
    v === "creating" || v === "open" || v === "ready_to_merge" || v === "merged" || v === "closed" || v === "unknown"
  )
}

function isPRCheckState(v: unknown): v is TaskPRStatus["checkState"] {
  return v === "none" || v === "pending" || v === "passing" || v === "failing" || v === "unknown"
}

function isTaskStatus(s: string): s is TaskStatus {
  return (
    s === "backlog" || s === "in_progress" || s === "in_review" || s === "done" || s === "canceled" || s === "error"
  )
}
