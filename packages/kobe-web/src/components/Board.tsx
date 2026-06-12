/**
 * Board — the kanban lens over the same tasks the rail and Overview show:
 * one column per persisted Task.status. Cards are live sessions, not
 * tickets — the dot is the engine's transient activity, and opening a card
 * lands on the task's real workspace (PTY/transcript).
 *
 * Drag a card (anywhere with the pointer; keyboard from the grip handle)
 * across columns to move its lifecycle status, or within a column to set a
 * persisted manual order (`task.reorder` positions). Drops paint
 * optimistically via the board-state override layer; the daemon's
 * task.snapshot confirms, and a typed error rolls back + toasts. Dragging
 * is disabled while the daemon/stream is down — a drop would silently
 * vanish (docs/design/web-kanban.md R4).
 */

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, GripVertical, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import {
  applyBoardOverrides,
  type BoardColumn,
  boardCardCount,
  buildBoard,
  isDroppableColumn,
  positionBetween,
  renormalizedMoves,
} from "../lib/board.ts"
import {
  clearPositionOverride,
  clearPositionOverrides,
  clearStatusOverride,
  reconcileBoardOverrides,
  setBoardQuery,
  setPositionOverride,
  setPositionOverrides,
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
  columnKey,
  engine,
  changes,
  canDrag,
  onOpen,
}: {
  task: Task
  columnKey: string
  engine?: EngineState
  changes?: { added: number; deleted: number }
  canDrag: boolean
  onOpen: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    disabled: !canDrag,
    data: { type: "card", columnKey },
  })
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
      style={{ transform: CSS.Transform.toString(transform), transition }}
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
    data: { type: "column" },
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
          {column.tasks.length + column.hiddenCount}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        <SortableContext
          items={column.tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {column.tasks.length === 0 ? (
            <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
              none
            </div>
          ) : (
            column.tasks.map((task) => (
              <BoardCard
                key={task.id}
                task={task}
                columnKey={column.key}
                engine={engineStates[task.id]}
                changes={worktreeChanges[task.worktreePath]}
                canDrag={canDrag}
                onOpen={() => onOpen(task.id)}
              />
            ))
          )}
        </SortableContext>
        {column.hiddenCount > 0 && (
          <div className="p-2 text-center text-[10px] text-subtle">
            +{column.hiddenCount} more — archive cards to thin this column
          </div>
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
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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
      applyBoardOverrides(tasks, overrides).filter((task) =>
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
    const activeId = String(event.active.id)
    const over = event.over
    if (!over) return
    const task = tasks.find((t) => t.id === activeId)
    if (!task) return

    // Where the card lands: a card target contributes its column + slot, a
    // column target means "append at the end of that column".
    const overData = over.data.current as
      | { type?: string; columnKey?: string }
      | undefined
    const overId = String(over.id)
    const displayedStatus = overrides[activeId]?.status ?? task.status
    const toKey =
      overData?.type === "card"
        ? (overData.columnKey ?? displayedStatus)
        : overId
    if (!isDroppableColumn(toKey)) return
    const toColumn = columns.find((c) => c.key === toKey)
    if (!toColumn) return

    // Final visual order of the target column (without the moving card).
    const others = toColumn.tasks.filter((t) => t.id !== activeId)
    let insertAt = others.length
    if (overData?.type === "card" && overId !== activeId) {
      const overIndex = others.findIndex((t) => t.id === overId)
      if (overIndex >= 0) {
        insertAt = overIndex
        if (toKey === displayedStatus) {
          // Same-column arrayMove semantics: dropping on a card below the
          // origin lands AFTER it, on a card above lands BEFORE it.
          const oldIndex = toColumn.tasks.findIndex((t) => t.id === activeId)
          const overFull = toColumn.tasks.findIndex((t) => t.id === overId)
          if (oldIndex >= 0 && overFull > oldIndex) insertAt = overIndex + 1
        }
      }
    } else if (overId === activeId) {
      return // dropped back onto itself — nothing to do
    }
    const finalOrder = others.toSpliced(insertAt, 0, task)

    const statusChanged = toKey !== task.status
    if (statusChanged) {
      setStatusOverride(activeId, toKey)
      rpc("task.status", { taskId: activeId, status: toKey }).catch(
        (err: unknown) => {
          clearStatusOverride(activeId, toKey)
          const illegal =
            err instanceof Error && err.name === "IllegalTransitionError"
          reportError(
            illegal ? `move blocked (${task.status} → ${toKey})` : "move task",
            err,
          )
        },
      )
    } else if (
      finalOrder.length === toColumn.tasks.length &&
      toColumn.tasks[insertAt]?.id === activeId
    ) {
      return // same column, same slot — no reorder needed
    }

    const position = positionBetween(
      finalOrder[insertAt - 1],
      finalOrder[insertAt + 1],
    )
    if (position !== null) {
      setPositionOverride(activeId, position)
      rpc("task.reorder", {
        moves: [{ taskId: activeId, position }],
      }).catch((err: unknown) => {
        clearPositionOverride(activeId, position)
        reportError("reorder task", err)
      })
    } else {
      // Midpoint degenerated (float precision) — renormalize the whole
      // column to spaced keys in ONE batch.
      const moves = renormalizedMoves(finalOrder)
      setPositionOverrides(moves)
      rpc("task.reorder", { moves }).catch((err: unknown) => {
        clearPositionOverrides(moves)
        reportError("reorder column", err)
      })
    }
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
