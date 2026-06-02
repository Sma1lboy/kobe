/**
 * Orchestrator (v0.6).
 *
 * What it owns: task lifecycle + worktree allocation + the reactive
 * snapshot the TUI subscribes to. That's all.
 *
 * What it lost vs v0.5:
 *   - The whole engine port (`spawn` / `resume` / `stream`). Engines
 *     (claude / codex) now run inside tmux panes, owned by tmux —
 *     kobe never drives them as subprocesses anymore.
 *   - `pumpEvents` / event-bus / per-tab subscribers / user-input
 *     broker. No live event stream from inside an engine to surface.
 *   - Chat-tab CRUD. There's exactly one engine session per task and
 *     tmux is its persistence.
 *   - Create-PR / merge / refresh-PR-status. KOB-232 will re-introduce
 *     create-PR as a `tmux send-keys` injection from the Ops pane.
 *
 * What it gained: `ensureWorktree(id)` — the path the ClaudeLauncher
 * calls before `tmux new-session` to make sure the task's worktree
 * exists on disk. (Worktree allocation is still lazy: `createTask`
 * records the intent; the directory only materialises when the user
 * actually enters the task.)
 */

import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { Accessor } from "solid-js"
import { createSignal } from "solid-js"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../types/task.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import {
  CannotDeleteMainTaskError,
  DirtyWorktreeError,
  IllegalTransitionError,
  TaskNotFoundError,
  WorktreeRemoveFailedError,
} from "./errors.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { autoBranch } from "./title.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
import { worktreePathFor } from "./worktree/paths.ts"
import { SlugAllocator } from "./worktree/slug-allocator.ts"

/** Input to {@link Orchestrator.createTask}. */
export interface CreateTaskInput {
  readonly repo: string
  /** Title for the sidebar row. Defaults to `(new task)` when omitted. */
  readonly title?: string
  /** Branch override; otherwise an auto branch is generated lazily. */
  readonly branch?: string
  /** Optional base ref for the new lazy worktree branch. */
  readonly baseRef?: string
  /** Engine vendor for the monitor's history-reader hint. */
  readonly vendor?: VendorId
}

export type Unsubscribe = () => void
export type TaskListListener = (snapshot: readonly Task[]) => void

export interface OrchestratorDeps {
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
}

/**
 * Placeholder title for tasks created before the user picks one.
 */
export const PLACEHOLDER_TASK_TITLE = "(new task)"

/**
 * Owner of the task lifecycle.
 *
 * Single source of truth for: which tasks exist, which worktree each
 * lives in, what its status / archived / pinned flag is. The TUI
 * subscribes via {@link tasksSignal} or {@link subscribeTasks}.
 */
export class Orchestrator {
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  private readonly slugs: SlugAllocator
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly activeTaskAcc: Accessor<string | null>
  private readonly setActiveTaskSig: (next: string | null) => void
  private readonly unsubscribeStore: TaskIndexUnsubscribe
  /** Per-repo lock so concurrent `ensureWorktree` calls don't race. */
  private readonly worktreeLocks = new Map<TaskId, Promise<void>>()
  /** Lock for `ensureMainTask` so concurrent calls don't double-create. */
  private readonly mainTaskLocks = new Map<string, Promise<Task>>()

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store
    this.worktrees = deps.worktrees
    this.slugs = new SlugAllocator((repo) =>
      this.store
        .list()
        .filter((t) => t.repo === repo && t.kind !== "main")
        .map((t) => {
          const slug = t.worktreePath.match(/([^/\\]+)[/\\]*$/)?.[1] ?? ""
          return slug
        })
        .filter((s) => s.length > 0),
    )
    const [tasks, setTasks] = createSignal<Task[]>(this.store.list())
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    const [activeTask, setActiveTask] = createSignal<string | null>(null)
    this.activeTaskAcc = activeTask
    this.setActiveTaskSig = (next) => setActiveTask(() => next)
    this.unsubscribeStore = this.store.subscribe((snapshot) => {
      this.setTasks(snapshot.slice())
    })
  }

  /**
   * Pre-flight hook for the TUI to await before the first render.
   * Currently a no-op — kept for API parity with the v0.5 daemon
   * orchestrator + future expansion.
   */
  async init(): Promise<void> {
    // No-op in v0.6. v0.5 had startup polling for plan-usage and rc-bridge;
    // both are gone. The TUI awaits this for parity.
  }

  /**
   * The active-task focus, in-process. Mirrors {@link RemoteOrchestrator}'s
   * daemon-backed `active-task` channel so the `KobeOrchestrator` union has
   * one API; in this local (no-daemon) mode there are no sibling panes to
   * sync, so it's just an in-process signal (KOB-247).
   */
  activeTaskSignal(): Accessor<string | null> {
    return this.activeTaskAcc
  }

  /** Set the active-task focus (local signal; no daemon to broadcast to). */
  async setActiveTask(id: TaskId | string | null): Promise<void> {
    this.setActiveTaskSig(id === null ? null : String(id))
  }

  /** Solid signal of the current task list. */
  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  /**
   * Subscribe to task-list updates. Fires once eagerly with the current
   * snapshot, then again after every mutation.
   */
  subscribeTasks(listener: TaskListListener): Unsubscribe {
    try {
      listener(this.store.list())
    } catch (err) {
      console.error("[kobe Orchestrator] task listener threw on subscribe:", err)
    }
    return this.store.subscribe(listener)
  }

  dispose(): void {
    this.unsubscribeStore()
  }

  // --- read ---

  listTasks(): Task[] {
    return this.store.list()
  }

  getTask(id: TaskId | string): Task | undefined {
    return this.store.get(id)
  }

  // --- write ---

  /**
   * Create a new task entry. Worktree allocation is lazy — the
   * `worktreePath` field stays empty until {@link ensureWorktree} is
   * called (typically by the ClaudeLauncher when the user enters the
   * task for the first time).
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.repo) throw new Error("createTask: repo is required")
    const title = (input.title ?? PLACEHOLDER_TASK_TITLE).trim() || PLACEHOLDER_TASK_TITLE
    // Leave the branch EMPTY for a lazily-allocated task (unless the caller
    // gave an explicit one): {@link ensureWorktree} derives a unique
    // `kobe/<slug>-<id>` from the task's OWN id when the worktree
    // materialises. We must NOT pre-derive a branch here — at create time
    // there is no task id yet, so every placeholder-titled task would get
    // the SAME name (`kobe/new-task-…`) and the second `git worktree add
    // -b` would fail on a duplicate branch (KOB-244). Deferring also lets
    // the branch follow a rename made before first enter.
    const task = await this.store.create({
      repo: input.repo,
      title,
      branch: input.branch ?? "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
    })
    // Remember the optional baseRef on a side-map so `ensureWorktree`
    // can use it. Not on the Task itself: base-ref is one-shot input
    // to the worktree create, not durable state.
    if (input.baseRef) this.pendingBaseRefs.set(task.id, input.baseRef)
    return task
  }

  /**
   * Ensure a `kind: "main"` task exists for the given repo. Idempotent.
   * The main task is pinned to the repo root (no `git worktree add`)
   * and lives at the top of the sidebar.
   */
  async ensureMainTask(repo: string): Promise<Task> {
    const existing = this.store.list().find((t) => t.kind === "main" && t.repo === repo)
    if (existing) return existing
    const inflight = this.mainTaskLocks.get(repo)
    if (inflight) return inflight
    const promise = (async () => {
      const created = await this.store.create({
        repo,
        title: titleFromRepo(repo),
        branch: "",
        worktreePath: repo,
        status: "backlog",
        kind: "main",
        vendor: DEFAULT_TASK_VENDOR,
      })
      return created
    })()
    this.mainTaskLocks.set(repo, promise)
    try {
      return await promise
    } finally {
      this.mainTaskLocks.delete(repo)
    }
  }

  /**
   * Materialise the worktree on disk for `task`. Idempotent: if the
   * worktree already exists, this is a fast path that just verifies
   * the recorded path. The ClaudeLauncher calls this before
   * `tmux new-session` so the engine's `cwd` is real.
   *
   * Returns the worktree path (same as `task.worktreePath` on success).
   */
  async ensureWorktree(id: TaskId | string): Promise<string> {
    const task = this.requireTask(id)
    if (task.kind === "main") return task.repo
    if (task.worktreePath) return task.worktreePath
    const inflight = this.worktreeLocks.get(task.id)
    if (inflight) {
      await inflight
      const refreshed = this.requireTask(task.id)
      return refreshed.worktreePath
    }
    const work = (async () => {
      const slug = await this.slugs.allocate(task.repo)
      try {
        const branch = task.branch || autoBranch(task.title, task.id)
        const baseRef = this.pendingBaseRefs.get(task.id)
        const info = await this.worktrees.createForTask({
          repo: task.repo,
          slug,
          branch,
          baseRef,
        })
        this.slugs.commit(task.repo, slug)
        this.pendingBaseRefs.delete(task.id)
        await this.store.update(task.id, {
          worktreePath: info.path,
          branch,
        })
      } catch (err) {
        this.slugs.cancel(task.repo, slug)
        throw err
      }
    })()
    this.worktreeLocks.set(task.id, work)
    try {
      await work
    } finally {
      this.worktreeLocks.delete(task.id)
    }
    const finalTask = this.requireTask(task.id)
    return finalTask.worktreePath
  }

  /** Rename a task. Empty / whitespace-only titles are rejected. */
  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.title === trimmed) return
    await this.store.update(task.id, { title: trimmed })
    await this.followBranchToTitle(task, trimmed)
  }

  /**
   * Keep a materialised task's branch in lockstep with its title WHILE the
   * branch is still the placeholder-derived default (`kobe/new-task-<id>`).
   * This is what lets a task auto-named from its first prompt also pick up a
   * meaningful branch instead of staying `kobe/new-task-…`. It fires at most
   * once: after the first rename the branch no longer matches the placeholder
   * derivation, so a later title change (or a manual `setBranch`) is never
   * clobbered. Skipped for `main` (no branch) and for not-yet-materialised
   * tasks (their branch is derived fresh from the title in {@link ensureWorktree},
   * so no rename is needed). Best-effort: a git rename failure is logged, not
   * thrown — the title update already committed and must stand.
   */
  private async followBranchToTitle(taskBefore: Task, newTitle: string): Promise<void> {
    if (taskBefore.kind === "main" || !taskBefore.worktreePath) return
    if (taskBefore.branch !== autoBranch(PLACEHOLDER_TASK_TITLE, taskBefore.id)) return
    const nextBranch = autoBranch(newTitle, taskBefore.id)
    if (nextBranch === taskBefore.branch) return
    try {
      await this.setBranch(taskBefore.id, nextBranch)
    } catch (err) {
      console.error(`[kobe] follow-branch-to-title failed for ${taskBefore.id}:`, err)
    }
  }

  /**
   * Persist the user's manual name for a task's ORIGIN ChatTab window (the
   * tmux F2 rename). The window holds the name while its tmux server is alive;
   * this durable copy lets the chat-tab namer restore it after a server
   * restart rebuilds the window fresh — otherwise it reverts to the
   * auto-derived first-prompt name. An empty name clears the override (the
   * window falls back to auto-naming). No tmux work here — the caller has
   * already renamed the live window; this only records the durable copy.
   */
  async setChatTabName(id: TaskId | string, name: string): Promise<void> {
    const trimmed = name.trim()
    const task = this.requireTask(id)
    if ((task.chatTabName ?? "") === trimmed) return
    await this.store.update(task.id, { chatTabName: trimmed || undefined })
  }

  /**
   * Rename a task's branch. For a materialised worktree this renames
   * the real git branch (`git branch -m`, which also moves HEAD on the
   * checked-out worktree so a running session keeps streaming); for a
   * not-yet-materialised task it just records the name, which
   * {@link ensureWorktree} then uses instead of the title-derived
   * default. Rejected for `kind: "main"` (it tracks the repo's own
   * branch — rename that with git directly, not through kobe).
   */
  async setBranch(id: TaskId | string, branch: string): Promise<void> {
    const trimmed = branch.trim()
    if (!trimmed) throw new Error("setBranch: branch is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.kind === "main") {
      throw new Error("setBranch: a main task tracks the repo's own branch; rename it with git directly")
    }
    if (task.branch === trimmed) return
    if (task.worktreePath) {
      await this.worktrees.renameBranch(task.worktreePath, task.branch, trimmed)
    }
    await this.store.update(task.id, { branch: trimmed })
  }

  /**
   * Change a task's engine vendor. Pure metadata — no git / tmux side
   * effects here. The change takes effect on the task's next enter:
   * `ensureSession` rebuilds a session whose `@kobe_vendor` tag no
   * longer matches, so the new tmux pane launches the new engine.
   */
  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    const task = this.requireTask(id)
    if (task.vendor === vendor) return
    await this.store.update(task.id, { vendor })
  }

  /** Toggle / set the `pinned` flag. No-op for `kind: "main"` (always pinned). */
  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = pinned ?? !task.pinned
    if ((task.pinned ?? false) === next) return
    await this.store.update(task.id, { pinned: next })
  }

  /** Toggle / set the `archived` flag. */
  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    const task = this.requireTask(id)
    const next = archived ?? !task.archived
    if (task.archived === next) return
    await this.store.update(task.id, { archived: next })
  }

  /**
   * Move a task between status states. The transitions are not
   * machine-enforced in v0.6 (the user does it from the sidebar) but
   * we still refuse `done` ↔ `error` flip-flops to surface bad code.
   */
  async setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    const task = this.requireTask(id)
    if (task.status === status) return
    if ((task.status === "done" && status === "error") || (task.status === "error" && status === "done")) {
      throw new IllegalTransitionError(task.status, status, task.id)
    }
    await this.store.update(task.id, { status })
  }

  /**
   * Permanently remove a task. Refuses to delete `kind: "main"`
   * tasks (the user removes the repo from saved repos instead).
   *
   * Worktree safety (KOB-244): without `opts.force` a worktree with
   * uncommitted / untracked changes is NOT destroyed — we throw
   * {@link DirtyWorktreeError} so the UI can re-prompt for explicit
   * force confirmation. And if `git worktree remove` itself fails
   * (locked / permission / corrupt git-dir) we throw
   * {@link WorktreeRemoveFailedError} and KEEP the index entry, so the
   * orphaned worktree stays visible + re-deletable instead of becoming
   * invisible on-disk debris. The index entry is dropped only after the
   * worktree is genuinely gone.
   */
  async deleteTask(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<void> {
    const task = this.store.get(id)
    if (!task) return
    if (task.kind === "main") {
      throw new CannotDeleteMainTaskError()
    }
    const force = opts?.force === true
    if (task.worktreePath) {
      if (!force) {
        let dirty = false
        try {
          dirty = await this.worktrees.isDirty(task.worktreePath)
        } catch {
          // Can't determine dirtiness (e.g. the path is already gone) —
          // treat as clean and let remove() handle the missing-dir case.
        }
        if (dirty) throw new DirtyWorktreeError(task.id)
      }
      try {
        await this.worktrees.remove(task.worktreePath, { force })
      } catch (err) {
        // Keep the index entry — see method doc. Surfacing instead of
        // the old console.warn-and-continue means a failed cleanup no
        // longer silently orphans the worktree.
        throw new WorktreeRemoveFailedError(task.id, err)
      }
    }
    await this.store.remove(task.id)
    this.pendingBaseRefs.delete(task.id)
    this.worktreeLocks.delete(task.id)
  }

  /**
   * Discover git worktrees on `repo` that exist on disk but aren't yet
   * linked to any task — candidates for adoption (KOB-256). Includes
   * worktrees outside the kobe convention root (the user's own
   * `git worktree add`). De-dupes against the task store by canonical
   * path so an already-adopted worktree never reappears.
   */
  async discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]> {
    if (!repo) throw new Error("discoverAdoptableWorktrees: repo is required")
    const all = await this.worktrees.listAll(repo)
    const linked = new Set(
      this.store
        .list()
        .filter((t) => t.worktreePath)
        .map((t) => canonPath(t.worktreePath)),
    )
    return all.filter((wt) => !linked.has(canonPath(wt.path)))
  }

  /**
   * Adopt an existing git worktree as a new task (KOB-256). The worktree
   * already exists on disk, so we record the task with its real path +
   * branch directly — `ensureWorktree` then short-circuits (non-empty
   * `worktreePath`) and never touches the filesystem. Validates the path
   * is a real worktree of `repo` and isn't already a task.
   */
  async adoptWorktree(input: {
    readonly repo: string
    readonly worktreePath: string
    readonly branch?: string
    readonly vendor?: VendorId
    readonly title?: string
  }): Promise<Task> {
    if (!input.repo) throw new Error("adoptWorktree: repo is required")
    if (!input.worktreePath) throw new Error("adoptWorktree: worktreePath is required")
    const target = canonPath(input.worktreePath)
    const candidates = await this.worktrees.listAll(input.repo)
    const match = candidates.find((wt) => canonPath(wt.path) === target)
    if (!match) {
      throw new Error(
        `adoptWorktree: ${input.worktreePath} is not an adoptable git worktree of ${input.repo} (unknown, detached, or the main checkout)`,
      )
    }
    const alreadyLinked = this.store.list().some((t) => t.worktreePath && canonPath(t.worktreePath) === target)
    if (alreadyLinked) throw new Error(`adoptWorktree: ${input.worktreePath} is already adopted as a task`)
    const branch = input.branch?.trim() || match.branch
    const title = (input.title ?? basename(match.path)).trim() || PLACEHOLDER_TASK_TITLE
    return this.store.create({
      repo: input.repo,
      title,
      branch,
      worktreePath: match.path,
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
    })
  }

  // --- internals ---

  /** Optional base-ref per task — consumed once by `ensureWorktree`. */
  private readonly pendingBaseRefs = new Map<TaskId, string>()

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }
}

function titleFromRepo(repo: string): string {
  const segs = repo.split(/[/\\]/).filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] ?? repo) : repo
}

/**
 * Resolve symlinks so two strings naming the same node compare equal
 * (macOS `/var` → `/private/var`). Falls back to `resolve` when the path
 * doesn't exist. Used to de-dupe discovered worktrees against task paths,
 * which may be stored in different (caller vs git) forms (KOB-256).
 */
function canonPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

// Avoid an unused-import warning while keeping toTaskId reachable for
// callers that need to brand a raw string id.
void toTaskId
