/**
 * Board — the kanban lens over the same tasks the rail and Overview show:
 * one column per persisted Task.status. Cards are live sessions, not
 * tickets — the dot is the engine's transient activity, and opening a card
 * lands on the task's real workspace (PTY/transcript).
 *
 * Two ways to move a card's lifecycle status: drag it (anywhere with the
 * pointer; keyboard from the grip handle) onto a column / slot, or use the
 * hover bar's status tags to jump it straight to a primary column without
 * dragging. Both paths share commitColumnMove: optimistic paint via the
 * board-state override layer, daemon task.snapshot confirmation, and a
 * typed-error rollback + toast. Moves are disabled while the daemon/stream
 * is down — they'd silently vanish (docs/design/web-kanban.md R4).
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
import {
  ArrowLeft,
  ClipboardCheck,
  Eye,
  GitPullRequest,
  GripVertical,
  ListTodo,
  Search,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import {
  applyBoardOverrides,
  BOARD_COLUMNS,
  type BoardColumn,
  boardCardCount,
  buildBoard,
  compareCards,
  isBoardTask,
  isDroppableColumn,
  planColumnDrop,
  repoOptions,
} from "../lib/board.ts"
import {
  clearPositionOverride,
  clearPositionOverrides,
  clearStatusOverride,
  reconcileBoardOverrides,
  setBoardQuery,
  setBoardRepo,
  setBoardStatusFilter,
  setPositionOverride,
  setPositionOverrides,
  setStatusOverride,
  useBoardState,
} from "../lib/board-state.ts"
import { fetchQuickPrompts } from "../lib/quick-prompts.ts"
import { createPrPrompt, reviewPrompt } from "../lib/review.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { ensureEngineTab, selectTask } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { sendPtyText } from "../lib/terminal.ts"
import { relativeTime } from "../lib/time.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { type Bucket, matchesStatusFilter } from "../lib/triage.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { BoardPeek } from "./BoardPeek.tsx"
import { ChangesChip, PrChip, TIP_ABOVE, TIP_RIGHT } from "./chips.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"

/** The hover bar's jump targets: the four always-visible lifecycle columns.
 *  error/canceled stay drag-only — they're fold-away exception states, not
 *  everyday destinations. */
const PRIMARY_COLUMNS = BOARD_COLUMNS.filter((spec) => spec.alwaysVisible)

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
  onMoveTo,
  onReview,
  onCreatePr,
  onOpen,
  onPeek,
}: {
  task: Task
  columnKey: string
  engine?: EngineState
  changes?: { added: number; deleted: number }
  canDrag: boolean
  onMoveTo: (statusKey: string) => void
  onReview?: () => void
  onCreatePr?: () => void
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
          data-tip="Drag to move"
          className={`absolute top-0 bottom-0 left-0 flex w-5 cursor-grab items-center justify-center text-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/card:opacity-100 ${TIP_RIGHT}`}
        >
          <GripVertical size={12} strokeWidth={1.8} />
        </button>
      )}
      {/* Hover bar: one tag per primary status — click to jump the card
          there without dragging. Overlays the card footer on hover only. */}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 border-t border-line bg-surface px-2 py-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
        {PRIMARY_COLUMNS.map((spec) => {
          const current = spec.key === columnKey
          return (
            <button
              key={spec.key}
              type="button"
              disabled={current || !canDrag}
              onClick={() => onMoveTo(spec.key)}
              title={current ? "Current column" : `Move to ${spec.title}`}
              className={`px-1 text-[10px] transition-colors ${
                current
                  ? `font-bold ${spec.accent}`
                  : "text-subtle hover:text-fg disabled:opacity-40 disabled:hover:text-subtle"
              }`}
            >
              {spec.title}
            </button>
          )
        })}
        <div className="ml-auto flex gap-0.5">
          {onReview && (
            <button
              type="button"
              onClick={onReview}
              aria-label={`Send review instruction to ${task.title || task.branch || task.id}`}
              data-tip="Review → done if it passes"
              className={`relative flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg ${TIP_ABOVE}`}
            >
              <ClipboardCheck size={11} strokeWidth={1.8} />
            </button>
          )}
          {onCreatePr && (
            <button
              type="button"
              onClick={onCreatePr}
              aria-label={`Open a PR for ${task.title || task.branch || task.id}`}
              data-tip="Open a PR for this branch"
              className={`relative flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg ${TIP_ABOVE}`}
            >
              <GitPullRequest size={11} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            onClick={onPeek}
            aria-label={`Peek ${task.title || task.branch || task.id}`}
            data-tip="Peek session"
            className={`relative flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg ${TIP_ABOVE}`}
          >
            <Eye size={11} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </div>
  )
}

function ColumnView({
  column,
  engineStates,
  worktreeChanges,
  canDrag,
  onMoveTo,
  onReview,
  onCreatePr,
  onOpen,
  onPeek,
}: {
  column: BoardColumn
  engineStates: Record<string, EngineState>
  worktreeChanges: Record<string, { added: number; deleted: number }>
  canDrag: boolean
  onMoveTo: (task: Task, statusKey: string) => void
  onReview: (task: Task) => void
  onCreatePr: (task: Task) => void
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
                onMoveTo={(statusKey) => onMoveTo(task, statusKey)}
                // Review only makes sense where work awaits a verdict.
                onReview={
                  column.key === "in_review" ? () => onReview(task) : undefined
                }
                // PR only for finished work that doesn't already have one
                // (the PrChip covers the has-a-PR case).
                onCreatePr={
                  column.key === "done" &&
                  (!task.prStatus?.lifecycle ||
                    task.prStatus.lifecycle === "unknown")
                    ? () => onCreatePr(task)
                    : undefined
                }
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
    deliver,
    hydrated,
    daemonConnected,
    streamConnected,
  } = useAppState()
  const { query, repo: repoFilter, statusFilter, overrides } = useBoardState()
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

  // Project chips: the distinct repos with board cards. Computed from the
  // UNfiltered list so chips (and their counts) don't vanish while one is
  // selected or a text query narrows the view.
  const repos = useMemo(() => repoOptions(tasks), [tasks])
  // The dispatcher seat exists ONLY on a repo-scoped board (a selected
  // project chip, or a board that has just one project): it's the repo's
  // main session (docs/design/dispatcher.md), which has no card of its own.
  const scopedRepo =
    repoFilter ?? (repos.length === 1 ? (repos[0]?.repo ?? null) : null)
  const dispatcherTask = useMemo(
    () =>
      scopedRepo
        ? tasks.find(
            (t) => t.kind === "main" && t.repo === scopedRepo && !t.archived,
          )
        : undefined,
    [tasks, scopedRepo],
  )
  // A selected project can disappear entirely (last card archived/deleted)
  // — snap back to All rather than showing a permanently empty board.
  useEffect(() => {
    if (repoFilter && !repos.some((option) => option.repo === repoFilter)) {
      setBoardRepo(null)
    }
  }, [repos, repoFilter])

  // The DISPLAY card set: repo chip + text query + the attention-filter chip.
  // The status filter is display-only — drag math (commitColumnMove) recomputes
  // the FULL column from applyBoardOverrides(tasks) so a filtered drop never
  // strands hidden cards on the wrong side of the move.
  const boardTasks = useMemo(
    () =>
      applyBoardOverrides(tasks, overrides).filter(
        (task) =>
          (!repoFilter || task.repo === repoFilter) &&
          matchesTask(task, query) &&
          matchesStatusFilter(
            engineStates[task.id],
            worktreeChanges[task.worktreePath],
            statusFilter,
          ),
      ),
    [
      tasks,
      overrides,
      query,
      repoFilter,
      statusFilter,
      engineStates,
      worktreeChanges,
    ],
  )
  const columns = useMemo(() => buildBoard(boardTasks), [boardTasks])
  const shownCount = boardCardCount(columns)
  // A no-match (chips/query narrowed every card away) vs the genuinely-empty
  // board: the empty branch differs (clear-filters vs new-task affordance).
  const hasAnyCard = useMemo(() => tasks.some(isBoardTask), [tasks])
  const filtered =
    Boolean(query) || statusFilter !== "all" || Boolean(repoFilter)
  const dragTask = dragTaskId
    ? boardTasks.find((t) => t.id === dragTaskId)
    : undefined

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  /**
   * Shared move executor for drag drops AND arrow/button moves: full-column
   * placement math, optimistic paint, and the status→reorder RPC sequencing
   * (a rejected transition rolls back both overrides and never reorders).
   */
  const commitColumnMove = (
    task: Task,
    toKey: string,
    visiblePrev: Task | undefined,
    visibleNext: Task | undefined,
  ): void => {
    const displayedStatus = overrides[task.id]?.status ?? task.status
    const statusChanged = toKey !== displayedStatus
    // Persistence math runs over the FULL column membership — uncapped and
    // unfiltered — so hidden cards never end up on the wrong side of a move
    // (planColumnDrop). The rendered neighbors only anchor the slot.
    const fullColumn = applyBoardOverrides(tasks, overrides)
      .filter(
        (t) =>
          t.id !== task.id &&
          isBoardTask(t) &&
          (t.status || "backlog") === toKey,
      )
      .sort(compareCards)
    const plan = planColumnDrop({
      fullColumn,
      moving: task,
      visiblePrev,
      visibleNext,
    })

    // Paint everything the move implies up front…
    if (statusChanged) setStatusOverride(task.id, toKey)
    if (plan.kind === "single") setPositionOverride(task.id, plan.position)
    else setPositionOverrides(plan.moves)

    const rollbackPosition = (): void => {
      if (plan.kind === "single") {
        clearPositionOverride(task.id, plan.position)
      } else {
        clearPositionOverrides(plan.moves)
      }
    }
    const sendReorder = (): void => {
      const moves =
        plan.kind === "single"
          ? [{ taskId: task.id, position: plan.position }]
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
    rpc("task.status", { taskId: task.id, status: toKey })
      .then(sendReorder)
      .catch((err: unknown) => {
        clearStatusOverride(task.id, toKey)
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

  /** One-click review: paste the review instruction (the user's template,
   *  if set, plus the one-time `done` authorization kobe always appends)
   *  into the task's engine session — spawns the engine if needed. */
  const sendReview = (task: Task): void => {
    const tabId = ensureEngineTab(task.id)
    fetchQuickPrompts()
      .then((prompts) =>
        sendPtyText(
          tabId,
          task.id,
          reviewPrompt(task.id, task.vendor, prompts.review),
        ),
      )
      .then(({ spawned }) => {
        pushToast(
          "success",
          spawned
            ? "review sent — engine starting, peek to watch"
            : "review sent to the session",
        )
      })
      .catch((err: unknown) => reportError("send review", err))
  }

  /** One-click PR: ask the session that DID the work to push its branch and
   *  open the PR — it writes the title/body from its own context. */
  const sendCreatePr = (task: Task): void => {
    const tabId = ensureEngineTab(task.id)
    fetchQuickPrompts()
      .then((prompts) =>
        sendPtyText(tabId, task.id, createPrPrompt(prompts.pr)),
      )
      .then(({ spawned }) => {
        pushToast(
          "success",
          spawned
            ? "PR instruction sent — engine starting, peek to watch"
            : "PR instruction sent to the session",
        )
      })
      .catch((err: unknown) => reportError("open PR", err))
  }

  /** Hover-tag move: jump the card straight to a status, landing at the
   *  TOP of the target — a deliberate move should stay under the eye. */
  const moveToStatus = (task: Task, toKey: string): void => {
    if (!canDrag || dragTaskId) return
    const displayed = overrides[task.id]?.status ?? task.status
    if (toKey === displayed || !isDroppableColumn(toKey)) return
    const target = columns.find((c) => c.key === toKey)
    commitColumnMove(task, toKey, undefined, target?.tasks[0])
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

    commitColumnMove(task, toKey, others[insertAt - 1], others[insertAt])
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
        {/* Sibling lens — the Board and Issues views are one hop apart. */}
        <button
          type="button"
          onClick={() => navigate({ to: "/issues" })}
          className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
          title="Open the Issues board"
        >
          <ListTodo size={14} strokeWidth={1.8} />
          <span className="text-[12px]">Issues</span>
        </button>
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
        {/* Project chips: partition the board by repo. Hidden for a
            single-project board — no point paying header space for a
            filter with one value. Click the active chip to deselect. */}
        {repos.length >= 2 && (
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setBoardRepo(null)}
              className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                repoFilter === null
                  ? "border-line-active bg-inset text-fg"
                  : "border-line text-subtle hover:text-fg"
              }`}
            >
              all
            </button>
            {repos.map((option) => (
              <button
                key={option.repo}
                type="button"
                title={option.repo}
                onClick={() =>
                  setBoardRepo(repoFilter === option.repo ? null : option.repo)
                }
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                  repoFilter === option.repo
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
              >
                {option.label}
                <span
                  className={
                    repoFilter === option.repo ? "text-muted" : "text-subtle"
                  }
                >
                  {" "}
                  {option.count}
                </span>
              </button>
            ))}
          </div>
        )}
        {/* Attention-filter chips: fold the triage buckets into the board as a
            display lens (the rail's chip recipe). "quiet" is dropped here the
            same way the rail drops it — idle+clean cards aren't a destination. */}
        <div className="flex items-center gap-1">
          {(
            [
              { key: "all", label: "All", title: "All cards" },
              {
                key: "attention",
                label: "Needs",
                title: "Needs input / errored / rate-limited",
              },
              { key: "working", label: "Run", title: "Engine running" },
              { key: "changes", label: "Dirty", title: "Uncommitted changes" },
            ] as Array<{ key: Bucket | "all"; label: string; title: string }>
          ).map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setBoardStatusFilter(c.key)}
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
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-subtle">
          {/* Dispatcher seat — repo-scoped boards only. Expands the repo's
              main session (where the dispatcher protocol's field notes land)
              in the right-side peek drawer; the board stays put. */}
          {dispatcherTask && (
            <button
              type="button"
              onClick={() => setPeekTaskId(dispatcherTask.id)}
              title={
                deliver?.source === "note" &&
                deliver.taskId === dispatcherTask.id
                  ? `Dispatcher — last field note ${relativeTime(new Date(deliver.at).toISOString()) || "just now"}`
                  : "Dispatcher — this repo's main session (field-note router)"
              }
              className="flex items-center gap-1.5 border border-line px-1.5 py-0.5 text-[10px] text-subtle transition-colors hover:border-primary hover:text-fg"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${activityColor(engineStates[dispatcherTask.id]?.state)}`}
              />
              dispatcher
            </button>
          )}
          {!canDrag && hydrated && (
            <span className="text-kobe-yellow">read-only (offline)</span>
          )}
          <span>
            {shownCount} card{shownCount === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      <DaemonBanner />

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {!hydrated ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && filtered && hasAnyCard ? (
          // Chips/query narrowed every card away — offer to clear BOTH the
          // status chip and the text query (the rail's clear-filters move).
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>No cards match.</p>
            <button
              type="button"
              onClick={() => {
                setBoardStatusFilter("all")
                setBoardQuery("")
              }}
              className="mt-3 border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
            >
              Clear filters
            </button>
          </div>
        ) : shownCount === 0 && !daemonConnected ? (
          // The daemon is down, so the task list the board paints may be
          // partial/stale — say so rather than implying an empty board.
          <p className="text-[12px] text-subtle">
            Can't reach the daemon — task list may be incomplete.
          </p>
        ) : shownCount === 0 ? (
          // Connected, genuinely no worktree tasks — offer the ways out.
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>No worktree tasks yet. Create one from the workspace.</p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate({ to: "/" })}
                className="border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
              >
                + New task
              </button>
              <button
                type="button"
                onClick={() => navigate({ to: "/" })}
                className="border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
              >
                Back to workspace
              </button>
            </div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragTaskId(null)}
          >
            <div className="relative flex h-full min-w-max gap-4">
              {columns.map((column) => (
                <ColumnView
                  key={column.key}
                  column={column}
                  engineStates={engineStates}
                  worktreeChanges={worktreeChanges}
                  canDrag={canDrag}
                  onMoveTo={moveToStatus}
                  onReview={sendReview}
                  onCreatePr={sendCreatePr}
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
