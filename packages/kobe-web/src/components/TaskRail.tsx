/**
 * The left task rail — filter/sort header, keyboard-first j/k + `/` nav,
 * Projects/Worktrees/Archived sections, and the settings footer. Split from
 * AppShell.tsx; the row building blocks live in TaskRailRows.tsx.
 */

import { useNavigate } from "@tanstack/react-router"
import { FolderInput, Loader2, Plus, Search, Settings, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { useEngines } from "../lib/engines.ts"
import {
  applyPrefSort,
  setRailQuery,
  setRailShowArchived,
  setRailSortMode,
  setRailStatusFilter,
  useRailState,
} from "../lib/rail-state.ts"
import { fetchSettings } from "../lib/settings.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"
import { matchesTask, sortTasks } from "../lib/task-list.ts"
import { reportError } from "../lib/toast.ts"
import { type Bucket, matchesStatusFilter } from "../lib/triage.ts"
import type { Task } from "../lib/types.ts"
import { isMixedEngineWorkspace, perRowEngineLabel } from "../lib/vendor.ts"
import { ArchivedHistoryPeek } from "./ArchivedHistoryPeek.tsx"
import { ArchivedRow, SectionHeader, TaskRow } from "./TaskRailRows.tsx"

export function TaskRail({
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

  // Engine label per row — but ONLY when the workspace runs mixed engines,
  // else every row would just repeat the same word. Engine-owned label via
  // the registry (useEngines), gated on the pure isMixedEngineWorkspace.
  const engines = useEngines()
  const mixedEngines = useMemo(
    () => isMixedEngineWorkspace(tasks as Task[]),
    [tasks],
  )
  const engineNameFor = (task: Task): string | null =>
    perRowEngineLabel(engines, task, mixedEngines)

  // Module store, not useState — the `/` → /task/$taskId nav remounts AppShell
  // (different route trees), which used to wipe these on the first task open
  // (issue #7). In-memory only: survives route nav, resets on full reload.
  const { query, statusFilter, sortMode, showArchived } = useRailState()
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

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
  // applyPrefSort is rising-edge (store-tracked), so a remount replaying the
  // same pref no longer stomps a local toggle.
  const prefSort = uiPrefs?.sortMode
  useEffect(() => {
    applyPrefSort(prefSort)
  }, [prefSort])
  const activeTasks = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const archivedTasks = useMemo(
    () => tasks.filter((t) => t.archived && t.kind !== "main"),
    [tasks],
  )
  const visible = useMemo(
    () =>
      sortTasks(
        activeTasks.filter(
          (task) =>
            matchesTask(task, query) &&
            matchesStatusFilter(
              engineStates[task.id],
              worktreeChanges[task.worktreePath],
              statusFilter,
            ),
        ),
        sortMode,
      ),
    [activeTasks, query, statusFilter, sortMode, engineStates, worktreeChanges],
  )
  const projects = visible.filter((task) => task.kind === "main")
  const worktrees = visible.filter((task) => task.kind !== "main")
  const booting = !hydrated || (!streamConnected && tasks.length === 0)
  const navigate = useNavigate()

  const open = (id: string): void => {
    selectTask(id)
    setActiveTaskBestEffort(id)
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
      const focusSearch = key === "/"
      // Only our keys proceed past here (cheap bail for every other keystroke).
      if (!down && !up && !focusSearch) return
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
      // `/` focuses the task filter (search-focus convention): / → type → Enter
      // jumps (the filter's own onKeyDown handles Enter/Escape).
      if (focusSearch) {
        event.preventDefault()
        filterRef.current?.focus()
        return
      }
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

  // Beta: archived-history preview gate (Settings → Experimental). Fetched once
  // on mount — it lives in the per-user settings KV, not the live SSE snapshot —
  // and the preview entry point stays hidden when off (default). Best-effort: a
  // failed fetch just leaves the gate closed.
  const [historyPreview, setHistoryPreview] = useState(false)
  const [previewTask, setPreviewTask] = useState<Task | null>(null)
  useEffect(() => {
    let alive = true
    void fetchSettings()
      .then((s) => {
        if (alive) setHistoryPreview(s.archivedHistoryPreview === true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

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
                setRailSortMode(sortMode === "default" ? "recent" : "default")
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
            ref={filterRef}
            value={query}
            onChange={(event) => setRailQuery(event.target.value)}
            onKeyDown={(event) => {
              // Keyboard-first: Enter jumps to the top match (visible is
              // already sorted + filtered), Escape clears the query.
              if (event.key === "Enter" && visible.length > 0) {
                event.preventDefault()
                open(visible[0].id)
                event.currentTarget.blur()
              } else if (event.key === "Escape" && query) {
                event.preventDefault()
                setRailQuery("")
              }
            }}
            placeholder="Filter tasks"
            className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-subtle focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setRailQuery("")}
              className="shrink-0 text-subtle hover:text-fg"
              aria-label="clear task filter"
              title="Clear filter"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </label>
        <div className="mt-2 flex items-center gap-1">
          {(
            [
              { key: "all", label: "All", title: "All tasks" },
              {
                key: "attention",
                label: "Needs",
                title: "Needs input / errored / rate-limited",
              },
              // Run (engine running) + Dirty (uncommitted changes) dropped as
              // low-frequency clutter. All (see everything) + Needs (the
              // attention spine wired to the tab badge + `n` nav) carry the
              // value. The "working"/"changes" buckets still exist in triage for
              // the Board; the rail just no longer offers them as quick filters.
            ] as Array<{ key: Bucket | "all"; label: string; title: string }>
          ).map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setRailStatusFilter(c.key)}
              title={c.title}
              className={`border px-1.5 py-0.5 text-[10px] transition-colors ${
                statusFilter === c.key
                  ? "border-primary bg-inset text-fg"
                  : "border-line bg-bg text-subtle hover:border-primary hover:text-fg"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
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
            <div>
              {query
                ? `No matches for “${query}”.`
                : "No tasks in this status."}
            </div>
            <button
              type="button"
              onClick={() => {
                setRailQuery("")
                setRailStatusFilter("all")
              }}
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
                engineName={engineNameFor(t)}
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
                engineName={engineNameFor(t)}
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
              onClick={() => setRailShowArchived(!showArchived)}
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
                <ArchivedRow
                  key={t.id}
                  task={t}
                  onRestore={() => restore(t)}
                  onPreview={
                    historyPreview ? () => setPreviewTask(t) : undefined
                  }
                />
              ))}
          </div>
        )}
      </div>
      <ArchivedHistoryPeek
        task={previewTask}
        onClose={() => setPreviewTask(null)}
      />
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
