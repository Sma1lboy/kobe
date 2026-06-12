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
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Eye, GripVertical, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import {
  applyBoardOverrides,
  type BoardColumn,
  boardCardCount,
  buildBoard,
  compareCards,
  isBoardTask,
  isDroppableColumn,
  planColumnDrop,
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
import { BoardPeek } from "./BoardPeek.tsx"
import { ChangesChip, PrChip } from "./chips.tsx"

/**
 * Column-aware keyboard moves: ↑/↓ step between cards of the SAME column
 * (geometric x-band), ←/→ jump to the nearest card — or the column surface,
 * for an empty column — in an adjacent column. The stock
 * sortableKeyboardCoordinates treats every droppable as a flat list, which
 * made ↓ at a column's bottom hop diagonally into the next column: a status
 * change the user didn't ask for.
 */
const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { active, collisionRect, droppableContainers, droppableRects } },
) => {
  if (!active || !collisionRect) return undefined
  if (
    event.code !== "ArrowUp" &&
    event.code !== "ArrowDown" &&
    event.code !== "ArrowLeft" &&
    event.code !== "ArrowRight"
  ) {
    return undefined
  }
  event.preventDefault()
  const cx = collisionRect.left + collisionRect.width / 2
  const candidates: Array<{ left: number; top: number; score: number }> = []
  for (const container of droppableContainers.getEnabled()) {
    if (container.id === active.id) continue
    const rect = droppableRects.get(container.id)
    if (!rect) continue
    const data = container.data.current as { type?: string } | undefined
    const rcx = rect.left + rect.width / 2
    const sameColumn = Math.abs(rcx - cx) < collisionRect.width / 2
    if (event.code === "ArrowUp" || event.code === "ArrowDown") {
      if (!sameColumn || data?.type !== "card") continue
      const dy =
        event.code === "ArrowUp"
          ? collisionRect.top - rect.top
          : rect.top - collisionRect.top
      if (dy > 1) candidates.push({ left: rect.left, top: rect.top, score: dy })
    } else {
      if (sameColumn) continue
      const dx = event.code === "ArrowLeft" ? cx - rcx : rcx - cx
      if (dx <= 1) continue
      // Nearest column wins; within it, the card closest vertically (a bare
      // column surface scores worse than its cards, so it only wins when
      // the column is empty).
      const dy = Math.abs(rect.top - collisionRect.top)
      candidates.push({
        left: rect.left,
        top: rect.top,
        score: dx * 10_000 + dy,
      })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  const target = candidates[0]
  return target ? { x: target.left, y: target.top } : undefined
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
  columnKey,
  engine,
  changes,
  canDrag,
  onOpen,
  onPeek,
}: {
  task: Task
  columnKey: string
  engine?: EngineState
  changes?: { added: number; deleted: number }
  canDrag: boolean
  onOpen: () => void
  onPeek: () => void
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
  // synthesizes a click; swallow it so a drop doesn't also navigate. Armed
  // only on a true→false transition — arming on every non-dragging render
  // put a 250ms click-dead window on freshly MOUNTED cards.
  const lastDragEndRef = useRef(0)
  const wasDraggingRef = useRef(false)
  useEffect(() => {
    if (wasDraggingRef.current && !isDragging) {
      lastDragEndRef.current = Date.now()
    }
    wasDraggingRef.current = isDragging
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
      <button
        type="button"
        onClick={onPeek}
        aria-label={`Peek ${task.title || task.branch || task.id}`}
        title="Peek session — live terminal + transcript without leaving the board (starts the session if it isn't running)"
        className="absolute right-1 bottom-1 flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle opacity-0 transition-opacity hover:border-primary hover:text-fg focus-visible:opacity-100 group-hover/card:opacity-100"
      >
        <Eye size={11} strokeWidth={1.8} />
      </button>
    </div>
  )
}

function ColumnView({
  column,
  engineStates,
  worktreeChanges,
  canDrag,
  onOpen,
  onPeek,
}: {
  column: BoardColumn
  engineStates: Record<string, EngineState>
  worktreeChanges: Record<string, { added: number; deleted: number }>
  canDrag: boolean
  onOpen: (id: string) => void
  onPeek: (id: string) => void
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
                onPeek={() => onPeek(task.id)}
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
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: boardKeyboardCoordinates,
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

  // Close the peek when its task vanishes (deleted/archived elsewhere) —
  // a drawer onto a dead session would just error confusingly.
  useEffect(() => {
    if (peekTaskId && !tasks.some((t) => t.id === peekTaskId)) {
      setPeekTaskId(null)
    }
  }, [tasks, peekTaskId])

  // Keyboard-first parity with Overview: `/` focuses the filter, Escape
  // clears it. Suppressed while typing in another field, and dormant while
  // the peek drawer is open — `/` yanking focus to the background filter
  // would punch through the drawer's focus trap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (peekTaskId) return
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
  }, [query, peekTaskId])

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

    // The visible drop slot (rendered slice, without the moving card).
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

    // Compare against the DISPLAYED status: a drag back to the origin column
    // while the first move's RPC is still in flight must repaint the card
    // home and send the compensating RPC (the daemon no-ops an equal
    // status), not silently no-op while the stale override wins.
    const statusChanged = toKey !== displayedStatus
    // A cross-column drop onto a capped column's SURFACE would land in the
    // "+N more" fold (after the last visible card, before the hidden ones).
    // Land it at the top instead, where the user can see it arrive.
    if (
      statusChanged &&
      overData?.type !== "card" &&
      toColumn.hiddenCount > 0
    ) {
      insertAt = 0
    }
    if (!statusChanged && toColumn.tasks[insertAt]?.id === activeId) {
      return // same column, same slot — nothing to persist
    }

    // Persistence math runs over the FULL column membership — uncapped and
    // unfiltered — so hidden cards never end up on the wrong side of a drop
    // (planColumnDrop). The rendered neighbors only anchor the slot.
    const fullColumn = applyBoardOverrides(tasks, overrides)
      .filter(
        (t) =>
          t.id !== activeId &&
          isBoardTask(t) &&
          (t.status || "backlog") === toKey,
      )
      .sort(compareCards)
    const plan = planColumnDrop({
      fullColumn,
      moving: task,
      visiblePrev: others[insertAt - 1],
      visibleNext: others[insertAt],
    })

    // Paint everything the drop implies up front…
    if (statusChanged) setStatusOverride(activeId, toKey)
    if (plan.kind === "single") setPositionOverride(activeId, plan.position)
    else setPositionOverrides(plan.moves)

    const rollbackPosition = (): void => {
      if (plan.kind === "single") {
        clearPositionOverride(activeId, plan.position)
      } else {
        clearPositionOverrides(plan.moves)
      }
    }
    const sendReorder = (): void => {
      const moves =
        plan.kind === "single"
          ? [{ taskId: activeId, position: plan.position }]
          : plan.moves
      rpc("task.reorder", { moves }).catch((err: unknown) => {
        rollbackPosition()
        reportError("reorder task", err)
      })
    }

    if (!statusChanged) {
      sendReorder()
      return
    }
    // …but the reorder RPC is GATED on the status RPC succeeding. Firing
    // them independently let a rejected transition (done ↔ error) still
    // persist a position computed from the foreign column's neighbors —
    // the card snapped home into the wrong slot, durably.
    rpc("task.status", { taskId: activeId, status: toKey })
      .then(sendReorder)
      .catch((err: unknown) => {
        clearStatusOverride(activeId, toKey)
        rollbackPosition()
        const illegal =
          err instanceof Error && err.name === "IllegalTransitionError"
        reportError(
          illegal
            ? `move blocked (${displayedStatus} → ${toKey})`
            : "move task",
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
                  onPeek={setPeekTaskId}
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

      {(() => {
        const peekTask = peekTaskId
          ? tasks.find((t) => t.id === peekTaskId)
          : undefined
        if (!peekTask) return null
        return (
          <BoardPeek
            key={peekTask.id}
            task={peekTask}
            engine={engineStates[peekTask.id]}
            onClose={() => setPeekTaskId(null)}
            onOpenWorkspace={() => {
              setPeekTaskId(null)
              open(peekTask.id)
            }}
          />
        )
      })()}
    </div>
  )
}
