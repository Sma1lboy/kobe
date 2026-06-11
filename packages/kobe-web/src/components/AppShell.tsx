/**
 * kobe web shell — the Conductor 5-region grammar in the claude theme.
 * Left: task rail. Center: workspace tabs (engine, terminal, notes, files).
 * Right: task tools / Changes rail (ToolsPanel). Plus a top
 * brand/status bar and a bottom status bar.
 */

import { useNavigate } from "@tanstack/react-router"
import { Loader2, Plus, Search, Settings, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"
import { reportError } from "../lib/toast.ts"
import type { ActivityState, EngineState, Task, TaskJob } from "../lib/types.ts"
import { NewTaskDialog } from "./NewTaskDialog.tsx"
import { Toasts } from "./Toasts.tsx"
import { ToolsPanel } from "./ToolsPanel.tsx"
import { WorkspaceTabs } from "./WorkspaceTabs.tsx"

function activityColor(state: ActivityState | undefined): string {
  switch (state) {
    case "running":
      return "bg-kobe-orange"
    case "waiting_permission":
      return "bg-kobe-blue"
    case "rate_limited":
      return "bg-kobe-yellow"
    case "error":
      return "bg-kobe-red"
    case "idle":
      return "bg-kobe-green/60"
    default:
      return "bg-subtle"
  }
}

function activityLabel(state: ActivityState | undefined): string {
  switch (state) {
    case "running":
      return "running"
    case "waiting_permission":
      return "needs input"
    case "rate_limited":
      return "rate limited"
    case "error":
      return "error"
    case "idle":
      return "idle"
    default:
      return ""
  }
}

function tail(path: string, max = 36): string {
  if (path.length <= max) return path
  return `…${path.slice(path.length - max + 1)}`
}

function taskUpdatedMs(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

type TaskSortMode = "default" | "recent"

function compareRecent(a: Task, b: Task): number {
  const byTime = taskUpdatedMs(b) - taskUpdatedMs(a)
  if (byTime !== 0) return byTime
  return b.id.localeCompare(a.id)
}

function sortTasks(tasks: Task[], mode: TaskSortMode): Task[] {
  const projects = tasks.filter((task) => task.kind === "main")
  const pinned = tasks.filter((task) => task.kind !== "main" && task.pinned)
  const regular = tasks.filter((task) => task.kind !== "main" && !task.pinned)
  if (mode === "recent") {
    projects.sort(compareRecent)
    pinned.sort(compareRecent)
    regular.sort(compareRecent)
  }
  return [...projects, ...pinned, ...regular]
}

function matchesTask(task: Task, query: string): boolean {
  if (!query) return true
  const haystack = [
    task.title,
    task.branch,
    task.repo,
    task.worktreePath,
    task.vendor,
    task.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return haystack.includes(query.toLowerCase())
}

function SectionHeader({
  children,
  suffix,
}: {
  children: React.ReactNode
  suffix?: string
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        {children}
      </span>
      {suffix ? (
        <>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] font-bold uppercase text-primary">
            {suffix}
          </span>
        </>
      ) : null}
    </div>
  )
}

function ChangesChip({
  counts,
}: {
  counts: { added: number; deleted: number } | undefined
}) {
  if (!counts || (counts.added === 0 && counts.deleted === 0)) return null
  return (
    <span className="ml-auto shrink-0 font-mono text-[10px]">
      <span className="text-kobe-green">+{counts.added}</span>{" "}
      <span className="text-kobe-red">−{counts.deleted}</span>
    </span>
  )
}

function TaskRow({
  task,
  engine,
  job,
  changes,
  active,
  onClick,
}: {
  task: Task
  engine?: EngineState
  job?: TaskJob
  changes?: { added: number; deleted: number }
  active: boolean
  onClick: () => void
}) {
  const materializing = job?.phase === "running"
  const label = materializing ? "materializing…" : activityLabel(engine?.state)
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full border-l-2 px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-inset"
          : "border-transparent hover:bg-surface"
      }`}
    >
      <div className="flex items-center gap-2">
        {materializing ? (
          <Loader2
            size={10}
            strokeWidth={2.5}
            className="shrink-0 animate-spin text-primary"
          />
        ) : (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
          />
        )}
        <span
          className={`truncate text-[13px] ${active ? "text-fg" : "text-fg/90"}`}
        >
          {task.title || task.branch}
        </span>
        {task.pinned && (
          <span className="ml-auto shrink-0 text-[10px] text-subtle">PIN</span>
        )}
        {!task.pinned && <ChangesChip counts={changes} />}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-subtle">
        <span className="truncate">{task.branch || "—"}</span>
        {label && <span className="ml-auto shrink-0 text-muted">{label}</span>}
      </div>
    </button>
  )
}

function ArchivedRow({
  task,
  onRestore,
}: {
  task: Task
  onRestore: () => void
}) {
  return (
    <div className="group flex items-center gap-2 border-l-2 border-transparent px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
        {task.title || task.branch}
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="shrink-0 border border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted opacity-0 transition-opacity hover:border-primary hover:text-fg group-hover:opacity-100"
      >
        Restore
      </button>
    </div>
  )
}

function TaskRail({
  onOpenSettings,
  onNewTask,
}: {
  onOpenSettings: () => void
  onNewTask: () => void
}) {
  const {
    tasks,
    engineStates,
    jobs,
    worktreeChanges,
    uiPrefs,
    hydrated,
    streamConnected,
  } = useAppState()
  const { selectedTaskId } = useTabsState()
  const [query, setQuery] = useState("")
  const [sortMode, setSortMode] = useState<TaskSortMode>("default")
  const [showArchived, setShowArchived] = useState(false)

  // Follow the TUI's sort preference (ui-prefs fan-out): toggling sort in any
  // kobe session re-sorts this rail too. The local toggle still works between
  // pref pushes — there's no prefs.set RPC yet, so web-side toggles are local.
  const prefSort = uiPrefs?.sortMode
  useEffect(() => {
    if (prefSort) setSortMode(prefSort)
  }, [prefSort])
  const activeTasks = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const archivedTasks = useMemo(
    () => tasks.filter((t) => t.archived && t.kind !== "main"),
    [tasks],
  )
  const visible = useMemo(
    () =>
      sortTasks(
        activeTasks.filter((task) => matchesTask(task, query)),
        sortMode,
      ),
    [activeTasks, query, sortMode],
  )
  const projects = visible.filter((task) => task.kind === "main")
  const worktrees = visible.filter((task) => task.kind !== "main")
  const booting = !hydrated || (!streamConnected && tasks.length === 0)
  const navigate = useNavigate()

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    // Push the deep link so tasks are shareable and back/forward walks the
    // task-switch history.
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  const restore = (task: Task): void => {
    void rpc("task.archive", { taskId: task.id, archived: false }).catch(
      (err) => reportError(`restore "${task.title || task.branch}"`, err),
    )
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-bg">
      <div className="border-b border-line bg-surface/50 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Tasks
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setSortMode((cur) => (cur === "default" ? "recent" : "default"))
              }
              className={`font-mono text-[10px] uppercase ${
                sortMode === "recent"
                  ? "text-primary"
                  : "text-muted hover:text-fg"
              }`}
              title="Toggle task sort"
            >
              sort
            </button>
            <span className="font-mono text-[10px] text-muted">
              {visible.length}/{activeTasks.length}
            </span>
            <button
              type="button"
              onClick={onNewTask}
              className="text-muted transition-colors hover:text-primary"
              title="New task"
              aria-label="New task"
            >
              <Plus size={14} strokeWidth={2.2} />
            </button>
          </div>
        </div>
        <label className="mt-2 flex h-8 items-center gap-2 border border-line bg-bg px-2 text-[12px] text-muted focus-within:border-line-active">
          <Search
            size={14}
            strokeWidth={1.8}
            className="shrink-0 text-subtle"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter tasks"
            className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-subtle focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 text-subtle hover:text-fg"
              aria-label="clear task filter"
              title="Clear filter"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </label>
      </div>
      <div className="flex-1 overflow-y-auto">
        {booting ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-subtle">
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            <span>connecting…</span>
          </div>
        ) : activeTasks.length === 0 ? (
          <div className="px-3 py-4 text-[12px] leading-relaxed text-subtle">
            <p>No tasks yet.</p>
            <button
              type="button"
              onClick={onNewTask}
              className="mt-3 border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
            >
              + New task
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-4 text-[12px] leading-relaxed text-subtle">
            <div>No matches for “{query}”.</div>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-3 border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
            >
              Clear filter
            </button>
          </div>
        ) : (
          <>
            {projects.length > 0 && <SectionHeader>Projects</SectionHeader>}
            {projects.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                engine={engineStates[t.id]}
                job={jobs[t.id]}
                changes={worktreeChanges[t.worktreePath]}
                active={t.id === selectedTaskId}
                onClick={() => open(t.id)}
              />
            ))}
            {worktrees.length > 0 && (
              <SectionHeader
                suffix={sortMode === "default" ? undefined : sortMode}
              >
                Worktrees
              </SectionHeader>
            )}
            {worktrees.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                engine={engineStates[t.id]}
                job={jobs[t.id]}
                changes={worktreeChanges[t.worktreePath]}
                active={t.id === selectedTaskId}
                onClick={() => open(t.id)}
              />
            ))}
          </>
        )}
        {!booting && archivedTasks.length > 0 && (
          <div className="mt-2 border-t border-line-subtle pb-2">
            <button
              type="button"
              onClick={() => setShowArchived((cur) => !cur)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
                Archived
              </span>
              <span className="font-mono text-[10px] text-subtle">
                {archivedTasks.length}
              </span>
              <span className="ml-auto font-mono text-[10px] text-subtle">
                {showArchived ? "−" : "+"}
              </span>
            </button>
            {showArchived &&
              archivedTasks.map((t) => (
                <ArchivedRow key={t.id} task={t} onRestore={() => restore(t)} />
              ))}
          </div>
        )}
      </div>
      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 border border-line bg-surface px-2 py-2 text-left text-[12px] text-muted transition-colors hover:border-primary hover:bg-inset hover:text-fg"
        >
          <Settings size={15} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  )
}

function TopBar() {
  const { daemonConnected, streamConnected, tasks } = useAppState()
  const { selectedTaskId } = useTabsState()
  const task = selectedTaskId
    ? tasks.find((item) => item.id === selectedTaskId)
    : null
  const ok = daemonConnected && streamConnected
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <span className="font-mono text-[13px] font-bold text-primary">
        [kobe]
      </span>
      {task ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-56 truncate rounded bg-inset px-2 py-0.5 text-[11px] text-fg">
            {task.title || task.branch}
          </span>
          <span className="hidden max-w-40 truncate font-mono text-[11px] text-subtle md:inline">
            {task.branch}
          </span>
        </div>
      ) : (
        <span className="rounded bg-inset px-2 py-0.5 text-[11px] text-muted">
          Workspace
        </span>
      )}
      <div className="ml-auto flex items-center gap-2 text-[11px] text-subtle">
        <span
          className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-kobe-green" : "bg-kobe-yellow"}`}
        />
        <span>
          {ok
            ? "daemon connected"
            : streamConnected
              ? "no daemon"
              : "connecting…"}
        </span>
      </div>
    </header>
  )
}

function StatusBar() {
  const { tasks, update } = useAppState()
  const { selectedTaskId } = useTabsState()
  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null
  const count = tasks.filter((t) => !t.archived).length
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-subtle">
      <span>
        {count} task{count === 1 ? "" : "s"}
      </span>
      {task && (
        <span className="min-w-0 truncate text-muted">
          {task.kind === "main" ? "project" : "worktree"} ·{" "}
          {tail(task.worktreePath, 54)}
        </span>
      )}
      <span className="ml-auto">
        {update?.latest ? `update ${update.latest} available` : "kobe web"}
      </span>
    </footer>
  )
}

function SettingsPage({ onClose }: { onClose: () => void }) {
  const { daemonConnected, streamConnected, update } = useAppState()

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Settings
        </span>
        <button
          type="button"
          onClick={onClose}
          className="border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
          <div className="border border-line bg-surface p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
              Connection
            </div>
            <div className="mt-4 space-y-3 text-[12px]">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted">Daemon</span>
                <span
                  className={
                    daemonConnected ? "text-kobe-green" : "text-kobe-yellow"
                  }
                >
                  {daemonConnected ? "connected" : "offline"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted">Event stream</span>
                <span
                  className={
                    streamConnected ? "text-kobe-green" : "text-kobe-yellow"
                  }
                >
                  {streamConnected ? "connected" : "connecting"}
                </span>
              </div>
            </div>
          </div>
          <div className="border border-line bg-surface p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
              Version
            </div>
            <div className="mt-4 space-y-3 text-[12px]">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted">Current</span>
                <span className="text-fg">
                  {typeof update?.current === "string"
                    ? update.current
                    : "unknown"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted">Latest</span>
                <span className="text-fg">
                  {typeof update?.latest === "string"
                    ? update.latest
                    : "unknown"}
                </span>
              </div>
            </div>
          </div>
          <div className="border border-line bg-surface p-4 md:col-span-2">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
              Workspace
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 text-[12px] md:grid-cols-3">
              <div className="border border-line-subtle bg-bg p-3">
                <div className="text-subtle">Brand</div>
                <div className="mt-2 font-mono text-primary">[kobe]</div>
              </div>
              <div className="border border-line-subtle bg-bg p-3">
                <div className="text-subtle">Notes</div>
                <div className="mt-2 text-fg">center tab</div>
              </div>
              <div className="border border-line-subtle bg-bg p-3">
                <div className="text-subtle">Changes</div>
                <div className="mt-2 text-fg">right rail</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <TaskRail
          onOpenSettings={() => setSettingsOpen(true)}
          onNewTask={() => setNewTaskOpen(true)}
        />
        {settingsOpen ? (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        ) : (
          <WorkspaceTabs />
        )}
        <ToolsPanel />
      </div>
      <StatusBar />
      {newTaskOpen && <NewTaskDialog onClose={() => setNewTaskOpen(false)} />}
      <Toasts />
    </div>
  )
}
