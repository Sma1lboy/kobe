/**
 * The on-disk task index (v0.6).
 *
 * Persists the {@link TaskIndex} at `<homeDir>/.kobe/tasks.json`. Single
 * writer per machine — multi-process safety lives in `lockfile.ts`,
 * write atomicity lives here (write-tmp + fsync + rename).
 *
 * Design notes:
 *
 *   - **Atomic write.** We never overwrite `tasks.json` directly. Write
 *     to `tasks.json.tmp`, fsync, then `rename()` — POSIX rename is
 *     atomic on the same filesystem.
 *   - **Corruption recovery.** `load()` never throws on bad JSON / a
 *     missing file. Returns an empty v3 index with a stderr warning.
 *   - **Migration v1/v2 → v3.** Older manifests had `tabs` /
 *     `sessionId` / `model` / `vendor` / `permissionMode` fields. v3
 *     drops them; we silently strip on load. The first save after
 *     load rewrites the file as v3 so the migration is permanent.
 *   - **Change notification.** Listeners fire after every mutation.
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Task, TaskId, TaskIndex, TaskPRStatus, TaskStatus, VendorId } from "../../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../../types/task.ts"
import { ulid } from "./ulid.ts"

export interface TaskIndexStoreOptions {
  /** Override the user's home dir. Tests use this to write into tmp. */
  readonly homeDir?: string
}

/**
 * Input shape for {@link TaskIndexStore.create}. `id`, `createdAt`,
 * `updatedAt` are auto-assigned. `archived` defaults to false.
 */
export type TaskCreateInput = Omit<Task, "id" | "createdAt" | "updatedAt" | "archived"> & {
  readonly archived?: boolean
}

const CURRENT_VERSION = 3 as const
const EMPTY_INDEX: TaskIndex = { version: CURRENT_VERSION, tasks: [] } as const
void EMPTY_INDEX

export type TaskIndexListener = (snapshot: readonly Task[]) => void
export type TaskIndexUnsubscribe = () => void

/**
 * Persistent store for the kobe task manifest.
 *
 * Lifecycle: callers `await store.load()` once at startup, then
 * operate synchronously against the in-memory copy. Each mutating
 * method (`create`, `update`, `archive`, `remove`) persists
 * immediately.
 */
export class TaskIndexStore {
  private readonly homeDir: string
  private readonly kobeDir: string
  private readonly path: string
  private readonly tmpPath: string
  private cache: { version: typeof CURRENT_VERSION; tasks: Task[] } = { version: CURRENT_VERSION, tasks: [] }
  private loaded = false
  private listeners = new Set<TaskIndexListener>()
  private saveChain: Promise<void> = Promise.resolve()

  constructor(options: TaskIndexStoreOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
    this.kobeDir = join(this.homeDir, ".kobe")
    this.path = join(this.kobeDir, "tasks.json")
    this.tmpPath = `${this.path}.tmp`
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

  /** Absolute path to the manifest file. Tests inspect this. */
  get filePath(): string {
    return this.path
  }

  /** Absolute path to the kobe state dir. Lockfile lives here too. */
  get stateDir(): string {
    return this.kobeDir
  }

  async load(): Promise<TaskIndex> {
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
    const payload: TaskIndex = this.snapshot()
    const json = `${JSON.stringify(payload, null, 2)}\n`

    const handle = await open(this.tmpPath, "w", 0o644)
    try {
      await handle.writeFile(json, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(this.tmpPath, this.path)
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
    await this.save()
    this.notifyListeners()
    return task
  }

  /**
   * Patch a task. Refuses to touch immutable fields (`id`, `createdAt`).
   * Bumps `updatedAt` to now and persists.
   */
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
    await this.save()
    this.notifyListeners()
    return next
  }

  async archive(id: TaskId | string, status: TaskStatus = "done"): Promise<Task> {
    return this.update(id, { status })
  }

  async remove(id: TaskId | string): Promise<void> {
    this.assertLoaded()
    const idx = this.cache.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return
    this.cache.tasks.splice(idx, 1)
    await this.save()
    this.notifyListeners()
  }

  /**
   * Remove the manifest file from disk. Used in tests and at uninstall.
   * Tolerant of "already gone".
   */
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
  }

  // --- internals ---

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

/**
 * Normalize an arbitrary JSON value into a v3 cache. Migrates v1 / v2
 * manifests by stripping the dropped fields (`tabs`, `activeTabId`,
 * `sessionId`, `model`, `modelEffort`, `permissionMode`). The first
 * save after load persists the v3 shape.
 */
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

/**
 * Coerce one persisted task entry into a v3 {@link Task}. Tolerant of
 * v1 / v2 shapes — silently drops the dropped fields.
 */
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

  // Self-heal pre-fix rows. Old kobe builds auto-flipped status to "done"
  // on every clean turn end, leaving the active sidebar full of `done`
  // tasks whose `archived` was still false. `done` is now reserved for
  // user-driven archive — heal those rows back to `in_progress` on load
  // so the sidebar's ✓ glyph only ever means "user archived this as
  // complete." Archived `done` rows are left alone.
  const archived = typeof v.archived === "boolean" ? v.archived : false
  const healedStatus: TaskStatus = v.status === "done" && !archived ? "in_progress" : v.status

  return {
    id: toTaskId(v.id),
    title: v.title,
    repo: v.repo,
    branch: v.branch,
    worktreePath: v.worktreePath,
    status: healedStatus,
    archived,
    pinned: typeof v.pinned === "boolean" ? v.pinned : false,
    kind: v.kind === "main" ? "main" : "task",
    vendor: isVendorId(v.vendor) ? v.vendor : DEFAULT_TASK_VENDOR,
    prStatus: coercePRStatus(v.prStatus),
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

function isVendorId(v: unknown): v is VendorId {
  return v === "claude" || v === "codex"
}

function isTaskStatus(s: string): s is TaskStatus {
  return (
    s === "backlog" || s === "in_progress" || s === "in_review" || s === "done" || s === "canceled" || s === "error"
  )
}
