/**
 * kobe web shell — the Conductor 5-region grammar in the claude theme.
 * Left: task rail. Center: workspace tabs (engine, terminal, notes, files).
 * Right: task tools / Changes rail (ToolsPanel). Plus a top
 * brand/status bar and a bottom status bar.
 */

import { Search, Settings, X } from "lucide-react"
import { useMemo, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"
import type { ActivityState, EngineState, Task } from "../lib/types.ts"
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

function TaskRow({
  task,
  engine,
  active,
  onClick,
}: {
  task: Task
  engine?: EngineState
  active: boolean
  onClick: () => void
}) {
  const label = activityLabel(engine?.state)
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
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
        />
        <span
          className={`truncate text-[13px] ${active ? "text-fg" : "text-fg/90"}`}
        >
          {task.title || task.branch}
        </span>
        {task.pinned && (
          <span className="ml-auto shrink-0 text-[10px] text-subtle">PIN</span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-subtle">
        <span className="truncate">{task.branch || "—"}</span>
        {label && <span className="ml-auto shrink-0 text-muted">{label}</span>}
      </div>
    </button>
  )
}

function TaskRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { tasks, engineStates } = useAppState()
  const { selectedTaskId } = useTabsState()
  const [query, setQuery] = useState("")
  const [sortMode, setSortMode] = useState<TaskSortMode>("default")
  const activeTasks = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
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

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
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
        {activeTasks.length === 0 ? (
          <p className="px-3 py-4 text-[12px] leading-relaxed text-subtle">
            No tasks yet. Add a repo from the TUI or run{" "}
            <code className="text-muted">kobe add &lt;path&gt;</code>.
          </p>
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
                active={t.id === selectedTaskId}
                onClick={() => open(t.id)}
              />
            ))}
          </>
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <TaskRail onOpenSettings={() => setSettingsOpen(true)} />
        {settingsOpen ? (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        ) : (
          <WorkspaceTabs />
        )}
        <ToolsPanel />
      </div>
      <StatusBar />
    </div>
  )
}
