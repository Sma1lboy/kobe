/**
 * The on-disk task index.
 *
 * Persists the {@link TaskIndex} at `<homeDir>/.kobe/tasks.json`. Single
 * writer per machine — multi-process safety lives in `lockfile.ts`,
 * write atomicity lives here (write-tmp + fsync + rename).
 *
 * Design notes:
 *
 *   - **Atomic write.** We never overwrite the live `tasks.json` directly.
 *     A crash mid-write would otherwise leave half a JSON document on
 *     disk. Instead we write to `tasks.json.tmp`, fsync the bytes, then
 *     `rename()` it over the target — POSIX guarantees rename is atomic
 *     on the same filesystem.
 *
 *   - **Corruption recovery.** `load()` never throws on bad JSON or a
 *     missing file. Returns `{ version: 1, tasks: [] }` instead, with a
 *     stderr warning. Rationale: a corrupted index should not prevent
 *     kobe from starting and surfacing the issue in the UI; that's much
 *     worse than silently starting fresh.
 *
 *   - **Migration.** `version` is a literal `1`. A pre-version manifest
 *     (no `version` field — anything we shipped before this stream
 *     existed) gets normalized to `version: 1` on load. We never
 *     silently mutate task records during migration; only the wrapper.
 *
 *   - **Immutability.** {@link Task} is `readonly`, so `update()` returns
 *     a new record rather than mutating in place. The store keeps an
 *     internal mutable list but never hands it out.
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Task, TaskId, TaskIndex, TaskStatus } from "../../types/task.ts"
import { toTaskId } from "../../types/task.ts"
import { ulid } from "./ulid.ts"

export interface TaskIndexStoreOptions {
  /** Override the user's home dir. Tests use this to write into tmp. */
  readonly homeDir?: string
}

/** The shape we accept on `create()` — id and timestamps are auto-assigned. */
export type TaskCreateInput = Omit<Task, "id" | "createdAt" | "updatedAt">

/** Empty manifest used as the recovery / first-run default. */
const EMPTY_INDEX: TaskIndex = { version: 1, tasks: [] } as const

/**
 * Persistent store for the kobe task manifest.
 *
 * Lifecycle: callers `await store.load()` once at startup, then operate
 * synchronously against the in-memory copy. Each mutating method
 * (`create`, `update`, `archive`) persists immediately.
 */
export class TaskIndexStore {
  private readonly homeDir: string
  private readonly kobeDir: string
  private readonly path: string
  private readonly tmpPath: string
  private cache: { version: 1; tasks: Task[] } = { version: 1, tasks: [] }
  private loaded = false

  constructor(options: TaskIndexStoreOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
    this.kobeDir = join(this.homeDir, ".kobe")
    this.path = join(this.kobeDir, "tasks.json")
    this.tmpPath = `${this.path}.tmp`
  }

  /** Absolute path to the manifest file. Tests inspect this. */
  get filePath(): string {
    return this.path
  }

  /** Absolute path to the kobe state dir. Lockfile lives here too. */
  get stateDir(): string {
    return this.kobeDir
  }

  /**
   * Read the manifest off disk into memory. Idempotent: subsequent calls
   * re-read (so external edits picked up on reload).
   */
  async load(): Promise<TaskIndex> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        this.cache = { version: 1, tasks: [] }
        this.loaded = true
        return this.snapshot()
      }
      // Other read errors (EACCES, EISDIR, …) are real — surface them.
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(
        `[kobe] tasks.json at ${this.path} is corrupted (${(err as Error).message}); recovering with empty index. The stale file is left in place.`,
      )
      this.cache = { version: 1, tasks: [] }
      this.loaded = true
      return this.snapshot()
    }

    this.cache = normalizeIndex(parsed, this.path)
    this.loaded = true
    return this.snapshot()
  }

  /**
   * Persist the in-memory cache to disk. Atomic: writes to tmp, fsyncs,
   * renames over target.
   */
  async save(): Promise<void> {
    this.assertLoaded()
    await mkdir(dirname(this.path), { recursive: true })

    const payload: TaskIndex = this.snapshot()
    const json = `${JSON.stringify(payload, null, 2)}\n`

    // open + writeFile + sync + close, then rename. We open the tmp
    // ourselves (rather than calling writeFile) so we can fsync before
    // rename — rename is atomic, but only durable if the bytes are
    // already on disk.
    const handle = await open(this.tmpPath, "w", 0o644)
    try {
      await handle.writeFile(json, "utf8")
      // sync the file's data to disk before we swing the inode pointer.
      // If a crash happens between writeFile and fsync, the rename
      // could expose an empty/partial file.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(this.tmpPath, this.path)
  }

  /** Return the task with this id, or undefined. */
  get(id: TaskId | string): Task | undefined {
    this.assertLoaded()
    return this.cache.tasks.find((t) => t.id === id)
  }

  /** Return a defensive copy of the task list. */
  list(): Task[] {
    this.assertLoaded()
    return this.cache.tasks.slice()
  }

  /**
   * Create a new task. Assigns ulid id + ISO timestamps, persists, and
   * returns the new record.
   */
  async create(partial: TaskCreateInput): Promise<Task> {
    this.assertLoaded()
    const now = new Date().toISOString()
    const task: Task = {
      ...partial,
      id: toTaskId(ulid()),
      createdAt: now,
      updatedAt: now,
    }
    this.cache.tasks.push(task)
    await this.save()
    return task
  }

  /**
   * Patch a task. Refuses to touch immutable fields (`id`, `createdAt`)
   * — if a caller tries, we silently ignore those keys rather than
   * throwing, because the alternative is a runtime crash on a typo. The
   * type system already discourages it via `Partial<Task>`'s readonly.
   *
   * Bumps `updatedAt` to now and persists.
   */
  async update(id: TaskId | string, patch: Partial<Task>): Promise<Task> {
    this.assertLoaded()
    const idx = this.cache.tasks.findIndex((t) => t.id === id)
    if (idx < 0) {
      throw new Error(`task not found: ${id}`)
    }
    const existing = this.cache.tasks[idx]
    if (!existing) {
      throw new Error(`task not found: ${id}`)
    }
    // Strip fields a caller is not allowed to mutate.
    const { id: _ignoredId, createdAt: _ignoredCreatedAt, ...mutable } = patch
    void _ignoredId
    void _ignoredCreatedAt

    const next: Task = {
      ...existing,
      ...mutable,
      // Always preserve identity & creation; bump updatedAt.
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.cache.tasks[idx] = next
    await this.save()
    return next
  }

  /**
   * Move a task to a terminal state. Caller picks `done` or `canceled`
   * (or any other status, but the convention is one of those). Equivalent
   * to `update(id, { status })` but named for the lifecycle event.
   */
  async archive(id: TaskId | string, status: TaskStatus = "done"): Promise<Task> {
    return this.update(id, { status })
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
    this.cache = { version: 1, tasks: [] }
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
      version: 1,
      tasks: this.cache.tasks.slice(),
    }
  }
}

/**
 * Normalize an arbitrary JSON value into a {@link TaskIndex}-shaped
 * mutable cache. Tolerant of:
 *
 *   - Pre-versioned manifests (no `version` field) — assumed to be
 *     v1-shaped already, just stamped with `version: 1`.
 *   - Future manifests with `version > 1` — we log and refuse to load,
 *     because guessing forward is worse than starting fresh.
 *   - Garbage at the task level — bad task entries are dropped with a
 *     warning, the rest of the index is kept.
 */
function normalizeIndex(parsed: unknown, source: string): { version: 1; tasks: Task[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[kobe] tasks.json at ${source} is not an object; recovering with empty index.`)
    return { version: 1, tasks: [] }
  }
  const obj = parsed as { version?: unknown; tasks?: unknown }
  const version = obj.version
  if (version !== undefined && version !== 1) {
    console.warn(
      `[kobe] tasks.json at ${source} has unsupported version=${String(version)}; recovering with empty index.`,
    )
    return { version: 1, tasks: [] }
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
  return { version: 1, tasks }
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
    !(v.sessionId === null || typeof v.sessionId === "string") ||
    typeof v.status !== "string" ||
    typeof v.createdAt !== "string" ||
    typeof v.updatedAt !== "string"
  ) {
    return null
  }
  if (!isTaskStatus(v.status)) return null
  return {
    id: toTaskId(v.id),
    title: v.title,
    repo: v.repo,
    branch: v.branch,
    worktreePath: v.worktreePath,
    sessionId: v.sessionId as string | null,
    status: v.status,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

function isTaskStatus(s: string): s is TaskStatus {
  return (
    s === "backlog" || s === "in_progress" || s === "in_review" || s === "done" || s === "canceled" || s === "error"
  )
}
