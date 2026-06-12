/**
 * Board — the kanban lens over the same tasks the rail and Overview show:
 * one column per persisted Task.status, newest activity first. Cards are
 * live sessions, not tickets — the dot is the engine's transient activity,
 * and opening a card lands on the task's real workspace (PTY/transcript).
 * Read-only in M1; drag-to-move is M2 (docs/design/web-kanban.md).
 */

import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import { boardCardCount, buildBoard } from "../lib/board.ts"
import { setBoardQuery, useBoardState } from "../lib/board-state.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { relativeTime } from "../lib/time.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { ChangesChip, PrChip } from "./chips.tsx"

function BoardCard({
  task,
  engine,
  changes,
  onOpen,
}: {
  task: Task
  engine?: EngineState
  changes?: { added: number; deleted: number }
  onOpen: () => void
}) {
  const label = activityLabel(engine?.state)
  const updated = relativeTime(task.updatedAt || task.createdAt)
  return (
    <button
      type="button"
      data-task-id={task.id}
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset"
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
          {task.title || task.branch || task.id}
        </span>
        <PrChip pr={task.prStatus} />
        {task.pinned && (
          <span className="shrink-0 text-[10px] text-subtle">PIN</span>
        )}
        <ChangesChip counts={changes} />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-subtle">
        <span className="min-w-0 truncate font-mono">
          {task.branch || task.repo}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {task.vendor && <span className="font-mono">{task.vendor}</span>}
          {label && <span className="text-muted">{label}</span>}
          {updated && <span>{updated}</span>}
        </span>
      </div>
    </button>
  )
}

export function Board() {
  const { tasks, engineStates, worktreeChanges, hydrated } = useAppState()
  const { query } = useBoardState()
  const navigate = useNavigate()
  const filterRef = useRef<HTMLInputElement>(null)

  // Keyboard-first parity with Overview: `/` focuses the filter, Escape
  // clears it. Suppressed while typing in another field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const t = event.target as HTMLElement | null
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      if (event.key === "/" && !inField) {
        event.preventDefault()
        filterRef.current?.focus()
      } else if (event.key === "Escape" && t === filterRef.current && query) {
        event.preventDefault()
        setBoardQuery("")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [query])

  const columns = useMemo(
    () => buildBoard(tasks.filter((task) => matchesTask(task, query))),
    [tasks, query],
  )
  const shownCount = boardCardCount(columns)

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
          title="Back to workspace"
        >
          <ArrowLeft size={15} strokeWidth={1.8} />
          <span className="text-[12px]">Workspace</span>
        </button>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Board
        </span>
        <label className="flex h-7 items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
          <Search
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-subtle"
          />
          <input
            ref={filterRef}
            value={query}
            onChange={(event) => setBoardQuery(event.target.value)}
            placeholder="Filter cards  ( / )"
            className="w-44 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setBoardQuery("")}
              className="shrink-0 text-subtle hover:text-fg"
              aria-label="clear filter"
              title="Clear filter"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </label>
        <span className="ml-auto font-mono text-[11px] text-subtle">
          {shownCount} card{shownCount === 1 ? "" : "s"}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {!hydrated ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && !query ? (
          <p className="text-[12px] text-subtle">
            No worktree tasks yet. Create one from the workspace.
          </p>
        ) : (
          <div className="flex h-full min-w-max gap-4">
            {columns.map((column) => (
              <section
                key={column.key}
                data-column={column.key}
                className="flex h-full w-72 shrink-0 flex-col"
              >
                <div className="mb-2 flex items-baseline gap-2">
                  <h2
                    className={`text-[11px] font-bold uppercase tracking-[0.12em] ${column.accent}`}
                  >
                    {column.title}
                  </h2>
                  <span className="font-mono text-[10px] text-subtle">
                    {column.tasks.length}
                  </span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
                  {column.tasks.length === 0 ? (
                    <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
                      none
                    </div>
                  ) : (
                    column.tasks.map((task) => (
                      <BoardCard
                        key={task.id}
                        task={task}
                        engine={engineStates[task.id]}
                        changes={worktreeChanges[task.worktreePath]}
                        onOpen={() => open(task.id)}
                      />
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
