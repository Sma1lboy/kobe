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

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Task, TaskId, TaskIndex, TaskStatus } from "../../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../../types/task.ts"
import { LockfileError, acquire, release } from "./lockfile.ts"
import { CURRENT_VERSION, backupCorruptManifest, normalizeIndex } from "./normalize.ts"
import { ulid } from "./ulid.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll interval while another kobe instance briefly holds the index lock. */
const LOCK_RETRY_DELAY_MS = 25
/**
 * How long to keep retrying before giving up. Holds are millisecond-scale
 * (one read-merge-write), so 5s is generous headroom for a contended machine;
 * past it we surface the {@link LockfileError} rather than block a UI thread.
 */
const LOCK_MAX_WAIT_MS = 5_000

/**
 * Acquire the index lock, retrying with a fixed backoff while it's held by a
 * *live* peer. {@link acquire} rejects immediately on a live holder (and steals
 * a stale one on its own), so the wait policy lives here. Non-contention errors
 * (and a blown deadline) propagate to the caller.
 */
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
  private readonly lockPath: string
  private cache: { version: typeof CURRENT_VERSION; tasks: Task[] } = { version: CURRENT_VERSION, tasks: [] }
  private loaded = false
  private listeners = new Set<TaskIndexListener>()
  private saveChain: Promise<void> = Promise.resolve()
  /**
   * Ids this process created/updated/moved since the last successful save, and
   * ids it removed. They drive the read-merge-write in {@link doSave}: a fresh
   * on-disk read is the base, OUR changes win for these ids, and concurrent
   * creates by peer processes survive. Cleared per-id once flushed.
   */
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

  /** Absolute path to the manifest file. Tests inspect this. */
  get filePath(): string {
    return this.path
  }

  /** Absolute path to the kobe state dir. Lockfile lives here too. */
  get stateDir(): string {
    return this.kobeDir
  }

  async load(): Promise<TaskIndex> {
    // A fresh load makes the in-memory copy match disk, so there are no
    // pending local changes to protect during the next merge.
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
      // Recovering to an empty index isn't enough: the next save() reads this
      // corrupt file as `[]` too and rewrites tasks.json from that empty base,
      // losing the user's rows for good. Copy the raw bytes aside FIRST.
      const backup = await backupCorruptManifest(this.path, raw)
      const recovery = backup
        ? `The original bytes were backed up to ${backup} so your tasks can be recovered.`
        : "The stale file is left in place."
      console.warn(
        `[kobe] tasks.json at ${this.path} is corrupted (${(err as Error).message}); recovering with empty index. ${recovery}`,
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

    // Snapshot the pending-change sets BEFORE awaiting anything: a peer's
    // changes land via a fresh disk read, but OUR concurrent in-process
    // mutations (queued behind this on `saveChain`) keep accumulating into
    // the live sets and are flushed by their own queued save.
    const dirty = new Set(this.dirtyIds)
    const removed = new Set(this.removedIds)

    // Cross-process mutual exclusion: serialize the read-merge-write so two
    // kobe instances (TUI + daemon + CLI) can't interleave and lose updates.
    // The lock is held only for this critical section, never across saves.
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

      // The write succeeded, so these changes are now durable: stop protecting
      // them in future merges (clearing only the snapshotted ids leaves any
      // change queued while we were writing intact for its own save).
      for (const id of dirty) this.dirtyIds.delete(id)
      for (const id of removed) this.removedIds.delete(id)

      // Surface concurrent creates a peer made: fold any merged task we didn't
      // already have into the cache so this process's UI sees it too. We only
      // ADD ids (never overwrite an existing cache entry) to avoid clobbering a
      // mutation that ran on the live cache while we were writing.
      const present = new Set(this.cache.tasks.map((t) => t.id))
      for (const task of mergedTasks) {
        if (!present.has(task.id)) this.cache.tasks.push(task)
      }
    } finally {
      await release(this.lockPath)
    }
  }

  /**
   * Read + parse the manifest fresh from disk, returning just the tasks.
   * Mirrors {@link load}'s tolerance — a missing or corrupt file reads as an
   * empty list — but never touches `this.cache` / listeners. Used as the merge
   * base so a save reflects a peer process's writes since we loaded.
   */
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
      // A corrupt on-disk file is recovered as empty by load(); don't let it
      // block a save here either. Our merged write replaces it.
      return []
    }
    return normalizeIndex(parsed, this.path).tasks
  }

  /**
   * Read-merge-write core: combine the fresh on-disk tasks with this process's
   * in-memory intent. Invariants (mirroring `state/store.ts`):
   *
   *   - OUR changes win for ids we touched (`dirty`) — last-write-wins per task.
   *   - A task we removed (`removed`) is NOT resurrected by a stale disk copy.
   *   - A task a peer removed (gone from disk, untouched by us) is NOT
   *     resurrected from our stale cache.
   *   - A task a peer created/updated (on disk, untouched by us) is preserved —
   *     concurrent creates are never dropped.
   */
  private mergeWithDisk(diskTasks: Task[], dirty: ReadonlySet<string>, removed: ReadonlySet<string>): Task[] {
    const diskById = new Map(diskTasks.map((t) => [t.id, t] as const))
    const result: Task[] = []
    const included = new Set<string>()

    // 1. Walk our cache in order — it carries our create/update/move intent and
    //    the ordering this process wants persisted.
    for (const task of this.cache.tasks) {
      if (dirty.has(task.id)) {
        result.push(task) // we changed it: our version wins
      } else {
        const onDisk = diskById.get(task.id)
        if (onDisk === undefined) continue // untouched here AND gone from disk: a peer removed it
        result.push(onDisk) // untouched here: take the peer's possibly-newer copy
      }
      included.add(task.id)
    }

    // 2. Fold in concurrent creates: tasks on disk we've never seen and never
    //    removed. Appended after our ordering.
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
    this.dirtyIds.add(String(id))
    await this.save()
    this.notifyListeners()
    return next
  }

  /**
   * Move a task up/down inside a caller-defined subset of task ids.
   * The subset lets UI ordering rules keep their partitions intact
   * (e.g. regular tasks move among regular tasks, pinned among pinned).
   */
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

  /**
   * Batch-assign web-board `position` keys. Deliberately does NOT bump
   * `updatedAt`: a board reorder is cosmetic placement, not task activity —
   * bumping would shuffle the TUI's `recent` sort from a web-only move.
   * One save + one listener notification for the whole batch, so N moves
   * publish ONE task.snapshot.
   */
  async reorder(moves: ReadonlyArray<{ readonly id: TaskId | string; readonly position: number }>): Promise<void> {
    this.assertLoaded()
    // Resolve the whole batch BEFORE mutating: a missing id must fail with
    // the cache untouched, not half-applied (the save below is all-or-none).
    const resolved = moves.map((move) => {
      const idx = this.cache.tasks.findIndex((t) => t.id === move.id)
      const existing = idx >= 0 ? this.cache.tasks[idx] : undefined
      if (!existing) throw new Error(`task not found: ${move.id}`)
      return { idx, position: move.position }
    })
    let dirty = false
    const before = new Map<number, Task>()
    // Ids this call newly marked dirty (skip ones already pending), so a
    // rollback removes exactly its own protection and nothing else.
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
      // A failed write must not leave the cache ahead of disk — the caller's
      // rejection rolls the UI back, so a later unrelated save would silently
      // resurrect the positions. Restore and rethrow.
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
    // Record the deletion so the read-merge-write doesn't resurrect this task
    // from a stale on-disk copy, and stop treating it as a pending edit.
    this.dirtyIds.delete(String(id))
    this.removedIds.add(String(id))
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
    this.dirtyIds.clear()
    this.removedIds.clear()
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
