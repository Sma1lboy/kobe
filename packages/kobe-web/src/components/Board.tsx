/**
 * Board — the kanban lens over the same tasks the rail and Overview show:
 * one column per persisted Task.status, newest activity first. Cards are
 * live sessions, not tickets — the dot is the engine's transient activity,
 * and opening a card lands on the task's real workspace (PTY/transcript).
 *
 * Drag a card (grip handle, or anywhere with the pointer) onto a column to
 * move its lifecycle status: the drop paints optimistically via the
 * board-state override layer, `task.status` does the real move, and the
 * daemon's task.snapshot confirms (or a typed error rolls back + toasts).
 * Dragging is disabled while the daemon/stream is down — a drop would
 * silently vanish (docs/design/web-kanban.md R4).
 */

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, GripVertical, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import {
  applyStatusOverrides,
  type BoardColumn,
  boardCardCount,
  buildBoard,
  isDroppableColumn,
} from "../lib/board.ts"
import {
  clearStatusOverride,
  reconcileBoardOverrides,
  setBoardQuery,
  setStatusOverride,
  useBoardState,
} from "../lib/board-state.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { relativeTime } from "../lib/time.ts"
import { reportError } from "../lib/toast.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { ChangesChip, PrChip } from "./chips.tsx"

/** Arrow keys jump between column centers (left/right) and hop cards
 *  (up/down) instead of the default 25px nudge — a keyboard move across the
 *  board is a handful of presses, not fifty. */
const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { droppableRects, droppableContainers, collisionRect } },
) => {
  if (!collisionRect) return undefined
  const step = 64 // roughly one card row
  switch (event.code) {
    case "ArrowUp":
      event.preventDefault()
      return { x: collisionRect.left, y: collisionRect.top - step }
    case "ArrowDown":
      event.preventDefault()
      return { x: collisionRect.left, y: collisionRect.top + step }
    case "ArrowLeft":
    case "ArrowRight": {
      event.preventDefault()
      const cx = collisionRect.left + collisionRect.width / 2
      const columns = droppableContainers
        .getEnabled()
        .map((container) => droppableRects.get(container.id))
        .filter((rect): rect is NonNullable<typeof rect> => !!rect)
        .map((rect) => ({ rect, cx: rect.left + rect.width / 2 }))
        .sort((a, b) => a.cx - b.cx)
      const target =
        event.code === "ArrowRight"
          ? columns.find((c) => c.cx > cx + 1)
          : [...columns].reverse().find((c) => c.cx < cx - 1)
      if (!target) return undefined
      return {
        x: target.cx - collisionRect.width / 2,
        y: Math.max(collisionRect.top, target.rect.top),
      }
    }
  }
  return undefined
}

function CardBody({
  task,
  engine,
  changes,
}: {
  task: Task
  engine?: EngineState
  changes?: { added: number; deleted: number }
}) {
  const label = activityLabel(engine?.state)
  const updated = relativeTime(task.updatedAt || task.createdAt)
  return (
    <>
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
    </>
  )
}

function BoardCard({
  task,
  engine,
  changes,
  canDrag,
  onOpen,
}: {
  task: Task
  engine?: EngineState
  changes?: { added: number; deleted: number }
  canDrag: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: task.id, disabled: !canDrag })
  // Pointer/touch drags start anywhere on the card; the keyboard lift lives
  // ONLY on the grip button, so Enter on the card body stays "open task".
  const { onKeyDown: _liftKey, ...pointerListeners } = listeners ?? {}
  // A pointer drag ends with pointerup on the card → the browser still
  // synthesizes a click; swallow it so a drop doesn't also navigate.
  const lastDragEndRef = useRef(0)
  useEffect(() => {
    if (!isDragging) lastDragEndRef.current = Date.now()
  }, [isDragging])
  const open = (): void => {
    if (Date.now() - lastDragEndRef.current < 250) return
    onOpen()
  }
  return (
    <div
      ref={setNodeRef}
      {...pointerListeners}
      data-task-id={task.id}
      className={`group/card relative ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        onClick={open}
        className="flex w-full cursor-pointer flex-col gap-1.5 border border-line bg-surface p-3 pl-6 text-left transition-colors hover:border-primary hover:bg-inset"
      >
        <CardBody task={task} engine={engine} changes={changes} />
      </button>
      {canDrag && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${task.title || task.branch || task.id}`}
          className="absolute top-0 bottom-0 left-0 flex w-5 cursor-grab items-center justify-center text-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <GripVertical size={12} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
}

function ColumnView({
  column,
  engineStates,
  worktreeChanges,
  canDrag,
  onOpen,
}: {
  column: BoardColumn
  engineStates: Record<string, EngineState>
  worktreeChanges: Record<string, { added: number; deleted: number }>
  canDrag: boolean
  onOpen: (id: string) => void
}) {
  const droppable = isDroppableColumn(column.key)
  const { setNodeRef, isOver } = useDroppable({
    id: column.key,
    disabled: !droppable,
  })
  return (
    <section
      ref={setNodeRef}
      data-column={column.key}
      className={`flex h-full w-72 shrink-0 flex-col border border-transparent ${
        isOver ? "border-line-active bg-inset/40" : ""
      }`}
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
              canDrag={canDrag}
              onOpen={() => onOpen(task.id)}
            />
          ))
        )}
      </div>
    </section>
  )
}

export function Board() {
  const {
    tasks,
    engineStates,
    worktreeChanges,
    hydrated,
    daemonConnected,
    streamConnected,
  } = useAppState()
  const { query, overrides } = useBoardState()
  const navigate = useNavigate()
  const filterRef = useRef<HTMLInputElement>(null)
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  )

  // A drop while disconnected would paint, fail to send, and silently revert
  // on reconnect — so the whole board goes read-only when either hop is down.
  const canDrag = daemonConnected && streamConnected

  // Confirmed/vanished overrides clear on every authoritative list change;
  // in-flight ones survive unrelated snapshots (R4 precise-clear rule).
  useEffect(() => {
    reconcileBoardOverrides(tasks)
  }, [tasks])

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

  const boardTasks = useMemo(
    () =>
      applyStatusOverrides(tasks, overrides).filter((task) =>
        matchesTask(task, query),
      ),
    [tasks, overrides, query],
  )
  const columns = useMemo(() => buildBoard(boardTasks), [boardTasks])
  const shownCount = boardCardCount(columns)
  const dragTask = dragTaskId
    ? boardTasks.find((t) => t.id === dragTaskId)
    : undefined

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  const onDragStart = (event: DragStartEvent): void => {
    setDragTaskId(String(event.active.id))
  }

  const onDragEnd = (event: DragEndEvent): void => {
    setDragTaskId(null)
    const taskId = String(event.active.id)
    const target = event.over ? String(event.over.id) : null
    if (!target || !isDroppableColumn(target)) return
    const task = tasks.find((t) => t.id === taskId)
    if (!task || task.status === target) return
    setStatusOverride(taskId, target)
    rpc("task.status", { taskId, status: target }).catch((err: unknown) => {
      clearStatusOverride(taskId, target)
      const illegal =
        err instanceof Error && err.name === "IllegalTransitionError"
      reportError(
        illegal ? `move blocked (${task.status} → ${target})` : "move task",
        err,
      )
    })
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
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-subtle">
          {!canDrag && hydrated && (
            <span className="text-kobe-yellow">read-only (offline)</span>
          )}
          <span>
            {shownCount} card{shownCount === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {!hydrated ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && !query ? (
          <p className="text-[12px] text-subtle">
            No worktree tasks yet. Create one from the workspace.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragTaskId(null)}
          >
            <div className="flex h-full min-w-max gap-4">
              {columns.map((column) => (
                <ColumnView
                  key={column.key}
                  column={column}
                  engineStates={engineStates}
                  worktreeChanges={worktreeChanges}
                  canDrag={canDrag}
                  onOpen={open}
                />
              ))}
            </div>
            <DragOverlay>
              {dragTask ? (
                <div className="flex w-72 flex-col gap-1.5 border border-line-active bg-inset p-3 pl-6 shadow-lg">
                  <CardBody
                    task={dragTask}
                    engine={engineStates[dragTask.id]}
                    changes={worktreeChanges[dragTask.worktreePath]}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </div>
  )
}
