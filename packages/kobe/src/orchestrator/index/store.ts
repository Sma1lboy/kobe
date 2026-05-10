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
 *
 *   - **Change notification.** The store is the single source of truth
 *     for task records, and any reactive consumer (the orchestrator's
 *     Solid signal that backs the sidebar) needs to know when the
 *     in-memory list changes. We expose a tiny `subscribe(cb)` API that
 *     fires after every mutation (`create`, `update`, `archive`, and
 *     reload via `load()`). Subscribers receive a fresh defensive
 *     snapshot — never the internal mutable list — so a subscriber
 *     cannot accidentally corrupt store state. This pattern decouples
 *     "the store mutated" from "a particular caller remembered to
 *     refresh some downstream signal" — the orchestrator no longer has
 *     to sprinkle `refreshSignal()` calls around its mutation methods.
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ChatTab, Task, TaskId, TaskIndex, TaskStatus } from "../../types/task.ts"
import { toTaskId } from "../../types/task.ts"
import { ulid } from "./ulid.ts"

export interface TaskIndexStoreOptions {
  /** Override the user's home dir. Tests use this to write into tmp. */
  readonly homeDir?: string
}

/**
 * Input shape for {@link TaskIndexStore.create}. `id` and timestamps are
 * auto-assigned. `archived` defaults to false. `tabs` / `activeTabId`
 * are synthesised from the optional `sessionId` when omitted.
 */
export type TaskCreateInput = Omit<Task, "id" | "createdAt" | "updatedAt" | "archived" | "tabs" | "activeTabId"> & {
  readonly archived?: boolean
  readonly tabs?: readonly ChatTab[]
  readonly activeTabId?: string
}

/** Empty manifest used as the recovery / first-run default. */
const EMPTY_INDEX: TaskIndex = { version: 2, tasks: [] } as const

/**
 * Callback invoked after every mutation to the store's in-memory list.
 * The argument is a fresh snapshot — callers can store it directly
 * without copying. The same value is what `list()` would return.
 */
export type TaskIndexListener = (snapshot: readonly Task[]) => void

/** Teardown for {@link TaskIndexStore.subscribe}. Idempotent. */
export type TaskIndexUnsubscribe = () => void

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
  private cache: { version: 2; tasks: Task[] } = { version: 2, tasks: [] }
  private loaded = false
  private listeners = new Set<TaskIndexListener>()

  constructor(options: TaskIndexStoreOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
    this.kobeDir = join(this.homeDir, ".kobe")
    this.path = join(this.kobeDir, "tasks.json")
    this.tmpPath = `${this.path}.tmp`
  }

  /**
   * Register a change listener. The callback fires AFTER every
   * mutation that affects the in-memory task list — `create`,
   * `update`, `archive`, and `load`. It also fires once eagerly with
   * the current snapshot when subscribed, so consumers don't need to
   * separately seed their own state. Returns an idempotent
   * unsubscribe function.
   *
   * Thread safety: not thread-safe (kobe is single-threaded by design).
   * If a listener throws we log and continue — one bad listener must
   * not break the bus for others.
   */
  subscribe(listener: TaskIndexListener): TaskIndexUnsubscribe {
    this.listeners.add(listener)
    // Fire eagerly so the consumer doesn't have to seed its mirror
    // separately from the subscription. Only fire if we're loaded —
    // pre-load subscribers receive their first event from the
    // load()-time notify.
    if (this.loaded) {
      try {
        listener(this.cache.tasks.slice())
      } catch (err) {
        // eslint-disable-next-line no-console
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
        this.cache = { version: 2, tasks: [] }
        this.loaded = true
        this.notifyListeners()
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
      this.cache = { version: 2, tasks: [] }
      this.loaded = true
      this.notifyListeners()
      return this.snapshot()
    }

    this.cache = normalizeIndex(parsed, this.path)
    this.loaded = true
    this.notifyListeners()
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
   *
   * Tab synthesis: callers may pass `tabs` + `activeTabId` directly.
   * When omitted (the common path) we synthesize a single tab from the
   * provided `sessionId`. The deprecated `sessionId` field on Task is
   * kept consistent with `tabs[0].sessionId` for v1 readers.
   */
  async create(partial: TaskCreateInput): Promise<Task> {
    this.assertLoaded()
    const now = new Date().toISOString()
    const { tabs: tabsIn, activeTabId: activeIn, sessionId, ...rest } = partial
    let tabs: readonly ChatTab[]
    let activeTabId: string
    if (tabsIn && tabsIn.length > 0) {
      tabs = tabsIn
      activeTabId = activeIn && tabsIn.some((t) => t.id === activeIn) ? activeIn : (tabsIn[0]?.id ?? "")
    } else {
      const tabId = ulid()
      tabs = [{ id: tabId, sessionId: sessionId ?? null, createdAt: now }]
      activeTabId = tabId
    }
    const firstSession = tabs[0]?.sessionId ?? null
    const task: Task = {
      archived: false,
      ...rest,
      sessionId: firstSession,
      tabs,
      activeTabId,
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

    // If the caller patched the deprecated top-level `sessionId` but
    // did NOT explicitly patch `tabs`, we treat that as a v1-style
    // write and propagate the new sessionId to the active tab. This
    // preserves the old API semantics (orchestrator.runTask's spawn
    // path used to do `update(id, { sessionId: handle.sessionId })`)
    // until every caller is migrated to `updateTab`.
    const sessionIdPatched = "sessionId" in patch
    const tabsPatched = "tabs" in patch
    let mergedTabs: readonly ChatTab[] =
      "tabs" in mutable && Array.isArray(mutable.tabs) ? (mutable.tabs as ChatTab[]) : existing.tabs
    if (sessionIdPatched && !tabsPatched) {
      const newSessionId = (patch.sessionId ?? null) as string | null
      const activeId = (mutable.activeTabId ?? existing.activeTabId) as string
      mergedTabs = mergedTabs.map((t) => (t.id === activeId ? { ...t, sessionId: newSessionId } : t))
    }
    const merged: Task = {
      ...existing,
      ...mutable,
      tabs: mergedTabs,
      // Always preserve identity & creation; bump updatedAt.
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    // Keep the deprecated `sessionId` alias coherent with the active
    // tab. Lets v1 readers and the read-only alias on Task stay
    // accurate without forcing every writer to remember to re-derive it.
    const activeTab = merged.tabs.find((t) => t.id === merged.activeTabId) ?? merged.tabs[0]
    const next: Task =
      activeTab && activeTab.sessionId !== merged.sessionId ? { ...merged, sessionId: activeTab.sessionId } : merged
    this.cache.tasks[idx] = next
    await this.save()
    this.notifyListeners()
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
   * Permanently remove a task from the index. Used by the orchestrator's
   * `deleteTask` flow alongside worktree + chat-history disposal — Jackson
   * wants `d` to fully discard, not just mark canceled. Idempotent: a
   * missing id is a no-op.
   */
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
    this.cache = { version: 2, tasks: [] }
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
      version: 2,
      tasks: this.cache.tasks.slice(),
    }
  }

  /**
   * Fire every registered listener with a fresh defensive snapshot.
   * Listeners that throw are logged but don't break the chain.
   */
  private notifyListeners(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.cache.tasks.slice()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[kobe TaskIndexStore] listener threw on notify:", err)
      }
    }
  }
}

/**
 * Normalize an arbitrary JSON value into a {@link TaskIndex}-shaped
 * mutable cache. Tolerant of:
 *
 *   - Pre-versioned manifests (no `version` field) — assumed to be
 *     v1-shaped already; coerced + migrated to v2.
 *   - v1 manifests — migrated to v2 (each task gets one synthesized
 *     ChatTab carrying the v1 sessionId, activeTabId points at it).
 *   - v2 manifests — loaded as-is.
 *   - Future manifests with `version > 2` — we log and refuse to load,
 *     because guessing forward is worse than starting fresh.
 *   - Garbage at the task level — bad task entries are dropped with a
 *     warning, the rest of the index is kept.
 */
function normalizeIndex(parsed: unknown, source: string): { version: 2; tasks: Task[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[kobe] tasks.json at ${source} is not an object; recovering with empty index.`)
    return { version: 2, tasks: [] }
  }
  const obj = parsed as { version?: unknown; tasks?: unknown }
  const version = obj.version
  if (version !== undefined && version !== 1 && version !== 2) {
    console.warn(
      `[kobe] tasks.json at ${source} has unsupported version=${String(version)}; recovering with empty index.`,
    )
    return { version: 2, tasks: [] }
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
  return { version: 2, tasks }
}

/**
 * Coerce one persisted task entry into a {@link Task}. Migrates v1
 * shapes (no `tabs`/`activeTabId`) into v2 by synthesizing a single
 * ChatTab from the legacy `sessionId`. Returns null for entries that
 * are too malformed to recover.
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
    !(v.sessionId === null || typeof v.sessionId === "string" || v.sessionId === undefined) ||
    typeof v.status !== "string" ||
    typeof v.createdAt !== "string" ||
    typeof v.updatedAt !== "string"
  ) {
    return null
  }
  if (!isTaskStatus(v.status)) return null

  const legacySessionId = (v.sessionId === undefined ? null : (v.sessionId as string | null)) ?? null

  // v2 fields — present in v2 manifests, absent in v1.
  const rawTabs = Array.isArray(v.tabs) ? (v.tabs as unknown[]) : null
  let tabs: ChatTab[] | null = null
  if (rawTabs) {
    tabs = []
    for (const t of rawTabs) {
      if (!t || typeof t !== "object") continue
      const tt = t as Record<string, unknown>
      if (typeof tt.id !== "string") continue
      if (!(tt.sessionId === null || typeof tt.sessionId === "string")) continue
      if (typeof tt.createdAt !== "string") continue
      const tab: ChatTab = {
        id: tt.id,
        sessionId: (tt.sessionId as string | null) ?? null,
        createdAt: tt.createdAt,
        ...(typeof tt.title === "string" ? { title: tt.title } : {}),
      }
      tabs.push(tab)
    }
  }

  let finalTabs: readonly ChatTab[]
  let finalActive: string
  if (tabs && tabs.length > 0) {
    finalTabs = tabs
    const persisted = typeof v.activeTabId === "string" ? v.activeTabId : null
    finalActive = persisted && tabs.some((t) => t.id === persisted) ? persisted : (tabs[0]?.id ?? "")
  } else {
    // v1 migration: synthesize one tab from the legacy sessionId. We
    // reuse the task's createdAt as the tab's createdAt — for migrated
    // tasks the tab effectively was-created when the task was.
    const synthesizedId = ulid()
    finalTabs = [{ id: synthesizedId, sessionId: legacySessionId, createdAt: v.createdAt }]
    finalActive = synthesizedId
  }

  // Keep the deprecated alias coherent with the active tab. Falls back
  // to the legacy field when the active tab can't be resolved (paranoia
  // — not expected on valid data).
  const activeTab = finalTabs.find((t) => t.id === finalActive) ?? finalTabs[0]
  const aliasSessionId = activeTab?.sessionId ?? legacySessionId

  return {
    id: toTaskId(v.id),
    title: v.title,
    repo: v.repo,
    branch: v.branch,
    worktreePath: v.worktreePath,
    sessionId: aliasSessionId,
    tabs: finalTabs,
    activeTabId: finalActive,
    status: v.status,
    // Wave 4.5: `archived` is a new field. Records written before its
    // introduction don't have it; default to false (i.e. "active /
    // working session"). The user can archive them with `a`.
    archived: typeof v.archived === "boolean" ? v.archived : false,
    // Tool-permission mode: optional. Records pre-dating the field
    // serialize as undefined which the engine layer reads as "no
    // --permission-mode flag" (CLI default). Unknown string values are
    // dropped — only the published union is honored, so manual edits to
    // the JSON can't smuggle invalid flags into the spawn args.
    permissionMode: isPermissionMode(v.permissionMode) ? v.permissionMode : undefined,
    // Model id: optional, free-form string. We don't enum-gate it
    // because Anthropic ships new model ids regularly and we want
    // stored choices to survive a model-list refresh (a user-pinned
    // `claude-opus-4-7` shouldn't get scrubbed when 4.8 drops).
    model: typeof v.model === "string" ? v.model : undefined,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

function isPermissionMode(v: unknown): v is import("@/types/task").PermissionMode {
  return (
    v === "default" ||
    v === "acceptEdits" ||
    v === "plan" ||
    v === "auto" ||
    v === "bypassPermissions" ||
    v === "dontAsk"
  )
}

function isTaskStatus(s: string): s is TaskStatus {
  return (
    s === "backlog" || s === "in_progress" || s === "in_review" || s === "done" || s === "canceled" || s === "error"
  )
}
