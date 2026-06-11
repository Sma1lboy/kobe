/**
 * kobe web shell — the Conductor 5-region grammar in the claude theme.
 * Left: task rail. Center: workspace tabs (engine, terminal, notes, files).
 * Right: task tools / Changes rail (ToolsPanel). Plus a top
 * brand/status bar and a bottom status bar.
 */

import { useNavigate } from "@tanstack/react-router"
import {
  CircleHelp,
  FolderInput,
  LayoutGrid,
  Loader2,
  PanelRight,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import { useEngines } from "../lib/engines.ts"
import {
  setNotificationsEnabled,
  setNotifyNavigate,
  useNotifyState,
} from "../lib/notify.ts"
import { tailPath } from "../lib/path-format.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { resetLayout, selectTask, useTabsState } from "../lib/tabs.ts"
import { matchesTask, sortTasks, type TaskSortMode } from "../lib/task-list.ts"
import { relativeTime } from "../lib/time.ts"
import { reportError } from "../lib/toast.ts"
import type { EngineState, Task, TaskJob, TaskPRStatus } from "../lib/types.ts"
import { AdoptDialog } from "./AdoptDialog.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import { KeyboardHelp } from "./KeyboardHelp.tsx"
import { NewTaskDialog } from "./NewTaskDialog.tsx"
import { ThemePicker } from "./ThemePicker.tsx"
import { Toasts } from "./Toasts.tsx"
import { ToolsPanel } from "./ToolsPanel.tsx"
import { WorkspaceTabs } from "./WorkspaceTabs.tsx"

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
    <span className="shrink-0 font-mono text-[10px]">
      <span className="text-kobe-green">+{counts.added}</span>{" "}
      <span className="text-kobe-red">−{counts.deleted}</span>
    </span>
  )
}

/** PR lifecycle/check → a short chip + theme color. Hidden when there's no
 *  PR (lifecycle unknown/none). Mirrors the daemon's TaskPRStatus shape. */
function PrChip({ pr }: { pr: TaskPRStatus | undefined }) {
  const lifecycle = pr?.lifecycle
  if (!pr || !lifecycle || lifecycle === "unknown") return null
  const check = pr.checkState
  const cls =
    lifecycle === "merged"
      ? "text-kobe-violet"
      : lifecycle === "closed"
        ? "text-kobe-red"
        : check === "failing"
          ? "text-kobe-red"
          : check === "passing"
            ? "text-kobe-green"
            : check === "pending"
              ? "text-kobe-yellow"
              : "text-kobe-blue"
  const label = pr.number ? `PR #${pr.number}` : "PR"
  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${cls}`}
      title={`${lifecycle}${check && check !== "none" ? ` · ${check}` : ""}`}
    >
      {label}
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
  const updated = relativeTime(task.updatedAt || task.createdAt)
  return (
    <button
      type="button"
      data-task-id={task.id}
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
          className={`min-w-0 flex-1 truncate text-[13px] ${active ? "text-fg" : "text-fg/90"}`}
        >
          {task.title || task.branch}
        </span>
        <PrChip pr={task.prStatus} />
        {task.pinned && (
          <span className="shrink-0 text-[10px] text-subtle">PIN</span>
        )}
        <ChangesChip counts={changes} />
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-subtle">
        <span className="min-w-0 truncate">{task.branch || "—"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {label && <span className="text-muted">{label}</span>}
          {updated && <span className="text-subtle">{updated}</span>}
        </span>
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
  onAdopt,
}: {
  onOpenSettings: () => void
  onNewTask: () => void
  onAdopt: () => void
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
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the selected task visible — j/k can move selection past the fold in a
  // long list; scroll the active row into view (no-op when already visible).
  useEffect(() => {
    if (!selectedTaskId) return
    listRef.current
      ?.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedTaskId])

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

  // Keyboard-first task nav: `j`/`k` move between visible tasks (TUI muscle
  // memory), and ↑/↓ do too BUT only when the rail (or nothing specific) owns
  // focus — so arrow-scroll still works natively inside the transcript / diff
  // panes. Suppressed in inputs, with any dialog/palette open, and while the
  // Settings overlay is open (it's not a role=dialog).
  // biome-ignore lint/correctness/useExhaustiveDependencies: open() closes only over stable refs; re-attaching on visible/selectedTaskId is enough and avoids re-arming every render.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key
      const isArrow = key === "ArrowDown" || key === "ArrowUp"
      const down = key === "j" || key === "ArrowDown"
      const up = key === "k" || key === "ArrowUp"
      if (!down && !up) return
      const t = event.target as HTMLElement | null
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return
      }
      if (document.querySelector("[role=dialog],[role=alertdialog]")) return
      if (document.querySelector("[data-settings-open]")) return
      // Arrow keys defer to native scrolling unless focus is on the rail or
      // nowhere specific (document.body) — don't swallow scroll on a focused
      // transcript/diff pane.
      if (
        isArrow &&
        t &&
        t !== document.body &&
        !listRef.current?.contains(t)
      ) {
        return
      }
      if (visible.length === 0) return
      event.preventDefault()
      const cur = visible.findIndex((task) => task.id === selectedTaskId)
      const next =
        cur === -1
          ? 0
          : Math.min(Math.max(cur + (down ? 1 : -1), 0), visible.length - 1)
      open(visible[next].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [visible, selectedTaskId])

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
              onClick={onAdopt}
              className="text-muted transition-colors hover:text-primary"
              title="Adopt an existing worktree"
              aria-label="Adopt worktree"
            >
              <FolderInput size={14} strokeWidth={1.9} />
            </button>
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
      <div ref={listRef} className="flex-1 overflow-y-auto">
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

function TopBar({
  onToggleTools,
  onShowHelp,
}: {
  onToggleTools: () => void
  onShowHelp: () => void
}) {
  const { daemonConnected, streamConnected, tasks } = useAppState()
  const { selectedTaskId } = useTabsState()
  const navigate = useNavigate()
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
      <div className="ml-auto flex items-center gap-3 text-[11px] text-subtle">
        <span className="hidden items-center gap-1.5 sm:flex">
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
        </span>
        <button
          type="button"
          onClick={() => navigate({ to: "/overview" })}
          className="flex items-center text-muted transition-colors hover:text-fg"
          aria-label="Overview"
          title="Overview — triage all tasks"
        >
          <LayoutGrid size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onShowHelp}
          className="hidden items-center text-muted transition-colors hover:text-fg sm:flex"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <CircleHelp size={15} strokeWidth={1.8} />
        </button>
        {/* Tools rail toggle — only on narrow screens where the rail is a drawer. */}
        <button
          type="button"
          onClick={onToggleTools}
          className="flex items-center text-muted transition-colors hover:text-fg lg:hidden"
          aria-label="Toggle task tools"
          title="Task tools"
        >
          <PanelRight size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  )
}

function DaemonBanner() {
  const { daemonConnected, streamConnected, hydrated } = useAppState()
  const [dismissed, setDismissed] = useState(false)
  // Only meaningful once we've hydrated and the SSE stream is up but the
  // daemon behind the bridge is down — panes go read-only / stale until it
  // comes back. A dropped SSE stream is a different state (TopBar shows it).
  const down = hydrated && streamConnected && !daemonConnected
  if (!down || dismissed) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-kobe-yellow/40 bg-kobe-yellow/10 px-3 py-1.5 text-[11px] text-kobe-yellow">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-kobe-yellow" />
      <span className="min-w-0 flex-1">
        The kobe daemon is offline — task data is frozen and mutations will fail
        until it reconnects (it auto-reconnects; the dashboard recovers on its
        own).
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-kobe-yellow/70 hover:text-kobe-yellow"
        aria-label="dismiss"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
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
          {tailPath(task.worktreePath, 54)}
        </span>
      )}
      <span className="ml-auto">
        {update?.latest ? `update ${update.latest} available` : "kobe web"}
      </span>
    </footer>
  )
}

function EnginesCard() {
  const engines = useEngines()
  return (
    <div className="border border-line bg-surface p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
        Engines
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {engines.map((engine) => (
          <span
            key={engine.id}
            className="border border-line bg-bg px-2 py-1 font-mono text-[11px] text-muted"
            title={engine.id}
          >
            {engine.label}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-subtle">
        Detected engine CLIs plus any custom engines you've registered. Switch a
        task's engine from its Task panel or the workspace tab dropdown.
      </p>
    </div>
  )
}

function NotificationsCard() {
  const { supported, permission, enabled } = useNotifyState()
  return (
    <div className="border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
          Notifications
        </div>
        {supported ? (
          <button
            type="button"
            onClick={() => void setNotificationsEnabled(!enabled)}
            disabled={permission === "denied" && !enabled}
            className={`border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-40 ${
              enabled
                ? "border-primary bg-inset text-fg"
                : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
            }`}
          >
            {enabled ? "On" : "Off"}
          </button>
        ) : (
          <span className="font-mono text-[10px] text-subtle">unsupported</span>
        )}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-subtle">
        {permission === "denied" && !enabled
          ? "Browser notifications are blocked — allow them in your browser's site settings to enable."
          : "Get a desktop notification when a task needs your input or errors while this tab is in the background. Click it to jump to the task."}
      </p>
    </div>
  )
}

function ResetLayoutCard() {
  const [armed, setArmed] = useState(false)
  const navigate = useNavigate()
  return (
    <div className="border border-line bg-surface p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
        Workspace
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-subtle">
        Reset the per-task tab layout (open tabs, splits, selection) if it ever
        gets wedged or cluttered. Pure browser state — your tasks, worktrees,
        and notes are untouched.
      </p>
      <button
        type="button"
        onClick={() => {
          if (!armed) {
            setArmed(true)
            return
          }
          resetLayout()
          // Leave the deep-link route so the /task/$taskId effect can't
          // immediately re-select the task we just cleared.
          void navigate({ to: "/" })
          setArmed(false)
        }}
        onBlur={() => setArmed(false)}
        className={`mt-3 border px-3 py-1.5 text-[11px] transition-colors ${
          armed
            ? "border-kobe-red/50 bg-kobe-red/10 text-kobe-red"
            : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
        }`}
      >
        {armed ? "Click again to reset layout" : "Reset layout"}
      </button>
    </div>
  )
}

function SettingsPage({ onClose }: { onClose: () => void }) {
  const { daemonConnected, streamConnected, update } = useAppState()

  return (
    // data-settings-open lets the rail's j/k handler suppress nav while this
    // overlay is up (it's an inline section, not a role=dialog).
    <section data-settings-open className="flex min-w-0 flex-1 flex-col bg-bg">
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
          <div className="md:col-span-2">
            <ThemePicker />
          </div>
          <NotificationsCard />
          <ResetLayoutCard />
          <div className="md:col-span-2">
            <EnginesCard />
          </div>
        </div>
      </div>
    </section>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // The right tools rail is a fixed column at lg+, and a slide-in drawer on
  // narrow windows (where it used to vanish entirely, making rename/changes
  // unreachable on a phone).
  const [toolsOpen, setToolsOpen] = useState(false)

  // Cmd/Ctrl+K toggles the palette; `?` opens help — but only when the user
  // isn't typing into a field (so "?" in an input types a literal question
  // mark, like GitHub/Linear).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen((cur) => !cur)
        return
      }
      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const t = event.target as HTMLElement | null
        const typing =
          t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.isContentEditable)
        if (!typing) {
          event.preventDefault()
          setHelpOpen(true)
        }
        return
      }
      // Escape closes the tools drawer — at the window level because focus is
      // rarely inside the drawer subtree, so a div-scoped onKeyDown wouldn't
      // see it. (The dialogs handle their own Escape; this is just the drawer.)
      if (event.key === "Escape") setToolsOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Let a notification click jump to its task (lib/notify can't useNavigate).
  useEffect(() => {
    setNotifyNavigate((taskId) => {
      selectTask(taskId)
      void rpc("task.setActive", { taskId }).catch(() => {})
      void navigate({ to: "/task/$taskId", params: { taskId } })
    })
    return () => setNotifyNavigate(null)
  }, [navigate])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <TopBar
        onToggleTools={() => setToolsOpen((cur) => !cur)}
        onShowHelp={() => setHelpOpen(true)}
      />
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <TaskRail
          onOpenSettings={() => setSettingsOpen(true)}
          onNewTask={() => setNewTaskOpen(true)}
          onAdopt={() => setAdoptOpen(true)}
        />
        {settingsOpen ? (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        ) : (
          <WorkspaceTabs />
        )}
        {/* lg+: inline column. Narrow: off-canvas drawer toggled from TopBar. */}
        <div className="hidden lg:flex">
          <ToolsPanel />
        </div>
        {toolsOpen && (
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; the × button + Escape are the keyboard paths.
          <div
            className="fixed inset-0 z-30 flex justify-end bg-black/50 lg:hidden"
            onClick={() => setToolsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setToolsOpen(false)
            }}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Task tools"
              className="h-full w-80 max-w-[85vw] border-l border-line bg-bg shadow-2xl"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={() => {}}
            >
              <ToolsPanel drawer onClose={() => setToolsOpen(false)} />
            </div>
          </div>
        )}
      </div>
      <StatusBar />
      {newTaskOpen && <NewTaskDialog onClose={() => setNewTaskOpen(false)} />}
      {adoptOpen && <AdoptDialog onClose={() => setAdoptOpen(false)} />}
      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewTask={() => setNewTaskOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Toasts />
    </div>
  )
}
