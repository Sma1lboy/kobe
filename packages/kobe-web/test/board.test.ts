import { afterEach, describe, expect, it } from "vitest"
import {
  applyBoardOverrides,
  BOARD_COLUMNS,
  type BoardCard,
  boardCardCount,
  buildBoard,
  buildProjectBoards,
  compareBacklogCards,
  compareCards,
  droppableId,
  effectivePosition,
  isBoardTask,
  isDroppableColumn,
  isLiveTask,
  labelRepo,
  liveTaskIds,
  parseDroppableId,
  planColumnDrop,
  POSITION_STEP,
  positionBetween,
  reconcileOverrides,
  renormalizedMoves,
  repoOptions,
  TERMINAL_COLUMN_CAP,
} from "../src/lib/board.ts"
import {
  clearPositionOverride,
  clearStatusOverride,
  getBoardState,
  reconcileBoardOverrides,
  resetBoardStateForTest,
  setBoardQuery,
  setBoardRepo,
  setBoardStatusFilter,
  setPositionOverrides,
  setStatusOverride,
} from "../src/lib/board-state.ts"
import { matchesStatusFilter } from "../src/lib/triage.ts"
import { matchesTask } from "../src/lib/task-list.ts"
import type { EngineState, Issue, Task } from "../src/lib/types.ts"

/**
 * Kanban column math. The load-bearing rules: columns bind to the persisted
 * Task.status only; archived/main rows never enter the board; error/canceled
 * columns fold away when empty; an unknown status must never silently drop a
 * card (it becomes a trailing dynamic column); within a column pinned floats,
 * then newest update first.
 */

const task = (over: Partial<Task>): Task =>
  ({
    id: over.id ?? "t",
    kind: "task",
    pinned: false,
    archived: false,
    status: "backlog",
    title: "",
    ...over,
  }) as Task

const issue = (over: Partial<Issue>): Issue => ({
  id: over.id ?? 1,
  title: "",
  status: "open",
  created: "2026-06-01",
  body: "",
  ...over,
})

/** Wrap a Task as a board card (buildBoard takes BoardCard[]). Preserves the
 *  task's own `kind` ("main"/"task") at runtime so buildBoard's isBoardTask
 *  filter still sees a main row; cast because the BoardCard task variant
 *  narrows `kind` to "task". */
const tc = (t: Task): BoardCard => ({ ...t, kind: t.kind }) as BoardCard
/** An issue card for `repo`. */
const ic = (repo: string, i: Issue): BoardCard => ({
  kind: "issue",
  repo,
  issue: i,
})
/** Wrap a Task[] as task cards. */
const cards = (tasks: Task[]): BoardCard[] => tasks.map(tc)

const columnKeys = (tasks: Task[]) =>
  buildBoard(cards(tasks)).map((c) => c.key)
/** Card ids in a column: task id for a task card, `#<id>` for an issue card. */
const cardId = (c: BoardCard): string =>
  c.kind === "issue" ? `#${c.issue.id}` : c.id
const columnIds = (tasks: Task[], key: string) =>
  buildBoard(cards(tasks))
    .find((c) => c.key === key)
    ?.cards.map(cardId)

describe("isBoardTask", () => {
  it("keeps regular worktree tasks", () => {
    expect(isBoardTask(task({}))).toBe(true)
  })
  it("excludes archived tasks and main project rows", () => {
    expect(isBoardTask(task({ archived: true }))).toBe(false)
    expect(isBoardTask(task({ kind: "main" }))).toBe(false)
  })
})

describe("buildBoard — column visibility", () => {
  it("shows the four primary columns even when empty", () => {
    expect(columnKeys([])).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
    ])
  })

  it("folds error/canceled away when empty, shows them when occupied", () => {
    expect(columnKeys([task({ id: "e", status: "error" })])).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "error",
    ])
    expect(columnKeys([task({ id: "c", status: "canceled" })])).toContain(
      "canceled",
    )
  })

  it("keeps canonical order per BOARD_COLUMNS", () => {
    const canonical = BOARD_COLUMNS.map((c) => c.key)
    const keys = columnKeys([
      task({ id: "a", status: "canceled" }),
      task({ id: "b", status: "error" }),
    ])
    expect(keys).toEqual(canonical.filter((k) => keys.includes(k)))
  })
})

describe("buildBoard — bucketing", () => {
  it("buckets by persisted status and never drops unknown statuses", () => {
    const tasks = [
      task({ id: "b1" }),
      task({ id: "p1", status: "in_progress" }),
      task({ id: "weird", status: "qa_hold" }),
    ]
    expect(columnIds(tasks, "backlog")).toEqual(["b1"])
    expect(columnIds(tasks, "in_progress")).toEqual(["p1"])
    // Unknown status → trailing dynamic column titled by the raw key.
    const board = buildBoard(cards(tasks))
    const extra = board[board.length - 1]
    expect(extra.key).toBe("qa_hold")
    expect(extra.title).toBe("qa_hold")
    expect(extra.cards.map(cardId)).toEqual(["weird"])
  })

  it("treats a missing status as backlog and excludes non-board tasks", () => {
    const tasks = [
      task({ id: "nostatus", status: "" }),
      task({ id: "arch", archived: true }),
      task({ id: "proj", kind: "main" }),
    ]
    expect(columnIds(tasks, "backlog")).toEqual(["nostatus"])
    expect(boardCardCount(buildBoard(cards(tasks)))).toBe(1)
  })
})

describe("compareCards — within a column", () => {
  it("floats pinned, then explicit position, default newest-created-first", () => {
    const old = task({ id: "old", createdAt: "2026-06-01T00:00:00Z" })
    const fresh = task({ id: "fresh", createdAt: "2026-06-10T00:00:00Z" })
    const pinnedOld = task({
      id: "pin",
      pinned: true,
      createdAt: "2026-05-01T00:00:00Z",
    })
    expect(columnIds([old, fresh, pinnedOld], "backlog")).toEqual([
      "pin",
      "fresh",
      "old",
    ])
    // An explicit position outranks the created-time default: positions are
    // small numbers, defaults are huge negative epochs, so positioned cards
    // sort after a never-dragged newest card only if placed there.
    const placedFirst = task({
      id: "placed",
      position: -9e12, // dragged above everything
      createdAt: "2026-01-01T00:00:00Z",
    })
    expect(columnIds([old, fresh, placedFirst], "backlog")?.[0]).toBe(
      "placed",
    )
    // Identical keys: higher id first (deterministic).
    const a = task({ id: "a", createdAt: "2026-06-01T00:00:00Z" })
    const b = task({ id: "b", createdAt: "2026-06-01T00:00:00Z" })
    expect(compareCards(a, b)).toBeGreaterThan(0)
  })

  it("created-time default is STABLE while engines run (ignores updatedAt)", () => {
    const a = task({
      id: "a",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-11T09:00:00Z",
    })
    const b = task({
      id: "b",
      createdAt: "2026-06-02T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    })
    // b is newer-created → first, even though a was updated more recently.
    expect(columnIds([a, b], "backlog")).toEqual(["b", "a"])
  })
})

describe("positionBetween / renormalizedMoves — drop math", () => {
  const at = (id: string, position: number) => task({ id, position })

  it("midpoint between neighbors, STEP beyond edges, 0 into empty", () => {
    expect(positionBetween(undefined, undefined)).toBe(0)
    expect(positionBetween(at("p", 1000), undefined)).toBe(
      1000 + POSITION_STEP,
    )
    expect(positionBetween(undefined, at("n", 1000))).toBe(
      1000 - POSITION_STEP,
    )
    expect(positionBetween(at("p", 1000), at("n", 2000))).toBe(1500)
  })

  it("returns null when float precision collapses the midpoint", () => {
    // Equal keys: no strictly-between value exists.
    expect(positionBetween(at("p", 1000), at("n", 1000))).toBeNull()
    // Adjacent doubles (2^-43 is one ULP at 1000): the midpoint rounds onto
    // a neighbor, so insertion must renormalize instead.
    expect(positionBetween(at("p", 1000), at("n", 1000 + 2 ** -43))).toBeNull()
  })

  it("renormalizedMoves spaces the whole column by POSITION_STEP", () => {
    const moves = renormalizedMoves([task({ id: "x" }), task({ id: "y" })])
    expect(moves).toEqual([
      { taskId: "x", position: POSITION_STEP },
      { taskId: "y", position: 2 * POSITION_STEP },
    ])
  })
})

describe("planColumnDrop — persistence plan over the FULL column", () => {
  const at = (id: string, over: Partial<Task> = {}) => task({ id, ...over })

  it("plain insert between full-column neighbors yields a single midpoint", () => {
    const a = at("a", { position: 1000 })
    const b = at("b", { position: 2000 })
    const plan = planColumnDrop({
      fullColumn: [a, b],
      moving: at("m"),
      visiblePrev: a,
      visibleNext: b,
    })
    expect(plan).toEqual({ kind: "single", position: 1500 })
  })

  it("clamps an unpinned drop below the pinned prefix instead of persisting a lie", () => {
    // P floats first regardless of position; dropping M "above P" must plan
    // M at the top of the UNPINNED region, not a position that pretends to
    // outrank the pin.
    const p = at("p", { pinned: true, position: 100 })
    const a = at("a", { position: 1000 })
    const plan = planColumnDrop({
      fullColumn: [p, a],
      moving: at("m"),
      visibleNext: p, // dropped at the very top of the column
    })
    expect(plan.kind).toBe("single")
    if (plan.kind === "single") {
      const simulated = [p, a, { ...at("m"), position: plan.position }].sort(
        compareCards,
      )
      expect(simulated.map((t) => t.id)).toEqual(["p", "m", "a"])
    }
  })

  it("anchors against hidden cards: dropping after the last VISIBLE card lands before the hidden ones", () => {
    // Full column [v1, v2, h1] where h1 is beyond the rendered slice (cap or
    // filter). Dropping after v2 must midpoint between v2 and h1 — computed
    // from visible neighbors only, the card would have landed AFTER h1.
    const v1 = at("v1", { position: 1000 })
    const v2 = at("v2", { position: 2000 })
    const h1 = at("h1", { position: 3000 })
    const plan = planColumnDrop({
      fullColumn: [v1, v2, h1],
      moving: at("m"),
      visiblePrev: v2,
      visibleNext: undefined, // end of the RENDERED slice
    })
    expect(plan).toEqual({ kind: "single", position: 2500 })
  })

  it("renormalizes the WHOLE column (hidden cards included) on midpoint degeneracy", () => {
    const a = at("a", { position: 1000 })
    const b = at("b", { position: 1000 }) // degenerate gap
    const hidden = at("h", { position: 5000 })
    const plan = planColumnDrop({
      fullColumn: [a, b, hidden],
      moving: at("m"),
      visiblePrev: a,
      visibleNext: b,
    })
    expect(plan.kind).toBe("renormalize")
    if (plan.kind === "renormalize") {
      expect(plan.moves.map((m) => m.taskId)).toEqual(["a", "m", "b", "h"])
      expect(plan.moves.map((m) => m.position)).toEqual([
        POSITION_STEP,
        2 * POSITION_STEP,
        3 * POSITION_STEP,
        4 * POSITION_STEP,
      ])
    }
  })

  it("an empty column plans position 0", () => {
    expect(
      planColumnDrop({ fullColumn: [], moving: at("m") }),
    ).toEqual({ kind: "single", position: 0 })
  })
})

describe("buildBoard — terminal-column cap", () => {
  it("caps done at TERMINAL_COLUMN_CAP with a hidden count, never caps active columns", () => {
    const done = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      task({ id: `d${String(i).padStart(3, "0")}`, status: "done" }),
    )
    const active = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      task({ id: `a${String(i).padStart(3, "0")}`, status: "in_progress" }),
    )
    const board = buildBoard(cards([...done, ...active]))
    const doneCol = board.find((c) => c.key === "done")
    const activeCol = board.find((c) => c.key === "in_progress")
    expect(doneCol?.cards).toHaveLength(TERMINAL_COLUMN_CAP)
    expect(doneCol?.hiddenCount).toBe(5)
    expect(activeCol?.cards).toHaveLength(TERMINAL_COLUMN_CAP + 5)
    expect(activeCol?.hiddenCount).toBe(0)
  })
})

describe("effectivePosition", () => {
  it("prefers the explicit position and falls back to -createdMs", () => {
    expect(effectivePosition(task({ position: 7 }))).toBe(7)
    const created = "2026-06-01T00:00:00Z"
    expect(effectivePosition(task({ createdAt: created }))).toBe(
      -Date.parse(created),
    )
    expect(effectivePosition(task({ createdAt: "garbage" }))).toBe(0)
  })
})

describe("board-state — module store filter", () => {
  afterEach(() => resetBoardStateForTest())

  it("holds the filter at module level so it survives view unmounts", () => {
    setBoardQuery("auth")
    expect(getBoardState().query).toBe("auth")
  })

  it("keeps the same snapshot reference for a no-op set (React skip)", () => {
    setBoardQuery("x")
    const before = getBoardState()
    setBoardQuery("x")
    expect(getBoardState()).toBe(before)
  })

  it("resets for test isolation", () => {
    setBoardQuery("y")
    resetBoardStateForTest()
    expect(getBoardState().query).toBe("")
  })

  it("holds the attention-filter chip and resets it for test isolation", () => {
    setBoardStatusFilter("attention")
    expect(getBoardState().statusFilter).toBe("attention")
    const before = getBoardState()
    setBoardStatusFilter("attention") // no-op → same snapshot (React skip)
    expect(getBoardState()).toBe(before)
    resetBoardStateForTest()
    expect(getBoardState().statusFilter).toBe("all")
  })
})

describe("board display predicate — repo + query + statusFilter compose", () => {
  afterEach(() => resetBoardStateForTest())

  // The Board's rendered card set is the AND of three independent filters:
  // the project chip, the text query, and the attention-filter chip. This
  // reconstructs that predicate over a small fixture and asserts each filter
  // narrows the set further — and that loosening any one widens it again.
  const running: EngineState = { state: "running" } as EngineState
  const idle: EngineState = { state: "idle" } as EngineState
  const tasks = [
    // kobe / matches "auth" / running
    task({ id: "k1", repo: "/u/kobe", title: "auth flow" }),
    // kobe / matches "auth" / idle (no engine state, clean)
    task({ id: "k2", repo: "/u/kobe", title: "auth retry" }),
    // kobe / no "auth" / running
    task({ id: "k3", repo: "/u/kobe", title: "ui polish" }),
    // other repo / matches "auth" / running
    task({ id: "o1", repo: "/u/web", title: "auth proxy" }),
  ]
  const engines: Record<string, EngineState | undefined> = {
    k1: running,
    k2: idle,
    k3: running,
    o1: running,
  }
  // All clean (no worktree changes) so the only "working" signal is `running`.
  const visible = (): string[] => {
    const { query, repo, statusFilter } = getBoardState()
    return tasks
      .filter(
        (t) =>
          (!repo || t.repo === repo) &&
          matchesTask(t, query) &&
          matchesStatusFilter(engines[t.id], undefined, statusFilter),
      )
      .map((t) => t.id)
  }

  it("ANDs all three filters; loosening any one widens the set", () => {
    // No filters → every board task.
    expect(visible()).toEqual(["k1", "k2", "k3", "o1"])

    // Repo chip alone → drop the foreign-repo card.
    setBoardRepo("/u/kobe")
    expect(visible()).toEqual(["k1", "k2", "k3"])

    // + query → only kobe cards that also match "auth".
    setBoardQuery("auth")
    expect(visible()).toEqual(["k1", "k2"])

    // + status chip → only the running one survives all three.
    setBoardStatusFilter("working")
    expect(visible()).toEqual(["k1"])

    // Loosen the status chip back to "all" → the idle "auth" card returns.
    setBoardStatusFilter("all")
    expect(visible()).toEqual(["k1", "k2"])

    // Loosen the repo chip → the foreign-repo "auth" card returns too.
    setBoardRepo(null)
    expect(visible()).toEqual(["k1", "k2", "o1"])
  })
})

describe("applyBoardOverrides — optimistic paint", () => {
  it("returns the same reference with no overrides", () => {
    const tasks = [task({ id: "a" })]
    expect(applyBoardOverrides(tasks, {})).toBe(tasks)
  })

  it("paints pending status AND position without mutating the source", () => {
    const a = task({ id: "a", status: "backlog" })
    const painted = applyBoardOverrides([a], {
      a: { status: "in_review", position: 512 },
    })
    expect(painted[0].status).toBe("in_review")
    expect(painted[0].position).toBe(512)
    expect(a.status).toBe("backlog")
    expect(a.position).toBeUndefined()
  })
})

describe("reconcileOverrides — R4 precise-clear rule", () => {
  it("keeps an in-flight override across an UNRELATED snapshot", () => {
    const overrides = { a: { status: "in_review" } }
    // Snapshot where some other task changed; a is still backlog.
    const next = reconcileOverrides(overrides, [
      task({ id: "a", status: "backlog" }),
      task({ id: "b", status: "done" }),
    ])
    expect(next).toBe(overrides) // same ref: nothing cleared, React skips
  })

  it("clears once the snapshot confirms the expected status", () => {
    const next = reconcileOverrides({ a: { status: "in_review" } }, [
      task({ id: "a", status: "in_review" }),
    ])
    expect(next).toEqual({})
  })

  it("clears PER FIELD: a confirmed status keeps an in-flight position", () => {
    const next = reconcileOverrides(
      { a: { status: "in_review", position: 512 } },
      [task({ id: "a", status: "in_review" })], // position not yet applied
    )
    expect(next).toEqual({ a: { position: 512 } })
  })

  it("drops the override when the task vanished mid-flight", () => {
    expect(reconcileOverrides({ gone: { status: "done" } }, [])).toEqual({})
  })
})

describe("board-state — override store", () => {
  afterEach(() => resetBoardStateForTest())

  it("records and rolls back a failed drop", () => {
    setStatusOverride("a", "in_review")
    expect(getBoardState().overrides).toEqual({ a: { status: "in_review" } })
    clearStatusOverride("a", "in_review")
    expect(getBoardState().overrides).toEqual({})
  })

  it("an older RPC's rollback must not clear a newer drag's override", () => {
    setStatusOverride("a", "in_review") // first drag (will fail)
    setStatusOverride("a", "done") // user drags again before the reject
    clearStatusOverride("a", "in_review") // first RPC rejects
    expect(getBoardState().overrides).toEqual({ a: { status: "done" } })
  })

  it("rolling back one field keeps the other", () => {
    setStatusOverride("a", "in_review")
    setPositionOverrides([{ taskId: "a", position: 256 }])
    clearPositionOverride("a", 256)
    expect(getBoardState().overrides).toEqual({ a: { status: "in_review" } })
  })

  it("reconciles against an authoritative task list", () => {
    setStatusOverride("a", "in_review")
    setStatusOverride("b", "done")
    reconcileBoardOverrides([
      task({ id: "a", status: "in_review" }), // confirmed → clear
      task({ id: "b", status: "backlog" }), // still in flight → keep
    ])
    expect(getBoardState().overrides).toEqual({ b: { status: "done" } })
  })
})

describe("isDroppableColumn", () => {
  it("accepts canonical lifecycle columns, rejects dynamic unknowns", () => {
    expect(isDroppableColumn("in_review")).toBe(true)
    expect(isDroppableColumn("canceled")).toBe(true)
    expect(isDroppableColumn("qa_hold")).toBe(false)
  })

  it("accepts composite project droppable ids by their column key", () => {
    // The unified board namespaces drop targets per project.
    expect(isDroppableColumn(droppableId("/u/proj/kobe", "in_review"))).toBe(
      true,
    )
    expect(isDroppableColumn(droppableId("/u/proj/kobe", "qa_hold"))).toBe(
      false,
    )
    // Repos can contain colons (ssh://): split from the RIGHT.
    expect(
      isDroppableColumn(droppableId("ssh://host/srv/widget", "done")),
    ).toBe(true)
  })
})

describe("droppableId / parseDroppableId — composite per-project ids", () => {
  it("round-trips a plain path repo", () => {
    const id = droppableId("/u/proj/kobe", "in_review")
    expect(id).toBe("/u/proj/kobe:in_review")
    expect(parseDroppableId(id)).toEqual({
      repo: "/u/proj/kobe",
      columnKey: "in_review",
    })
  })

  it("round-trips a colon-bearing remote repo (splits from the right)", () => {
    const id = droppableId("ssh://host/srv/widget", "done")
    expect(parseDroppableId(id)).toEqual({
      repo: "ssh://host/srv/widget",
      columnKey: "done",
    })
  })

  it("returns null for a string without a usable separator", () => {
    expect(parseDroppableId("in_review")).toBeNull()
    expect(parseDroppableId(":in_review")).toBeNull()
    expect(parseDroppableId("/u/proj/kobe:")).toBeNull()
  })
})


describe("repoOptions — project chips", () => {
  it("counts board cards only: archived and main rows don't register a project", () => {
    const tasks = [
      task({ id: "a", repo: "/u/proj/kobe" }),
      task({ id: "b", repo: "/u/proj/kobe" }),
      task({ id: "m", repo: "/u/proj/kobe", kind: "main" }),
      task({ id: "x", repo: "/u/proj/old", archived: true }),
    ]
    expect(repoOptions(tasks)).toEqual([
      { repo: "/u/proj/kobe", label: "kobe", count: 2 },
    ])
  })

  it("labels are basenames, sorted; colliding basenames get parent/basename", () => {
    const tasks = [
      task({ id: "a", repo: "/u/work/api" }),
      task({ id: "b", repo: "/u/personal/api" }),
      task({ id: "c", repo: "/u/proj/zeta" }),
    ]
    expect(repoOptions(tasks)).toEqual([
      { repo: "/u/personal/api", label: "personal/api", count: 1 },
      { repo: "/u/work/api", label: "work/api", count: 1 },
      { repo: "/u/proj/zeta", label: "zeta", count: 1 },
    ])
  })

  it("handles trailing slashes and remote-style repo keys", () => {
    const tasks = [
      task({ id: "a", repo: "/u/proj/kobe/" }),
      task({ id: "b", repo: "ssh://host/srv/repos/widget" }),
    ]
    expect(repoOptions(tasks)).toEqual([
      { repo: "/u/proj/kobe/", label: "kobe", count: 1 },
      { repo: "ssh://host/srv/repos/widget", label: "widget", count: 1 },
    ])
  })
})

describe("labelRepo — shared basename/parent labeler", () => {
  it("returns the basename when it's unique in the set", () => {
    expect(labelRepo("/u/proj/kobe", ["/u/proj/kobe", "/u/proj/zeta"])).toBe(
      "kobe",
    )
  })

  it("disambiguates colliding basenames to parent/basename", () => {
    const repos = ["/u/work/api", "/u/personal/api"]
    expect(labelRepo("/u/work/api", repos)).toBe("work/api")
    expect(labelRepo("/u/personal/api", repos)).toBe("personal/api")
  })

  it("ignores trailing slashes and handles remote keys", () => {
    expect(labelRepo("/u/proj/kobe/", ["/u/proj/kobe/"])).toBe("kobe")
    expect(
      labelRepo("ssh://host/srv/repos/widget", ["ssh://host/srv/repos/widget"]),
    ).toBe("widget")
  })
})

describe("isLiveTask / liveTaskIds — issue↔task dedup", () => {
  it("a task is live unless archived or terminal (done/canceled/error)", () => {
    expect(isLiveTask(task({ status: "backlog" }))).toBe(true)
    expect(isLiveTask(task({ status: "in_progress" }))).toBe(true)
    expect(isLiveTask(task({ status: "in_review" }))).toBe(true)
    expect(isLiveTask(task({ status: "done" }))).toBe(false)
    expect(isLiveTask(task({ status: "canceled" }))).toBe(false)
    expect(isLiveTask(task({ status: "error" }))).toBe(false)
    expect(isLiveTask(task({ status: "in_progress", archived: true }))).toBe(
      false,
    )
  })

  it("collects LIVE task ids from the FULL task list (link is now one-way)", () => {
    // The link reversed: a task no longer carries issueId; dedup keys on the
    // task's own id (Issue.taskId points AT these). Dead/archived/main rows
    // drop out so their issue can resurface.
    const tasks = [
      task({ id: "t1", repo: "/u/kobe", status: "in_progress" }), // live
      task({ id: "t2", repo: "/u/kobe", status: "done" }), // dead → not live
      task({ id: "t3", repo: "/u/kobe", archived: true }), // archived → not live
      task({ id: "t4", repo: "/u/web", status: "backlog" }), // live, other repo
      task({ id: "m1", repo: "/u/kobe", kind: "main" }), // main row → skipped
    ]
    const ids = liveTaskIds(tasks)
    expect([...ids].sort()).toEqual(["t1", "t4"])
  })
})

describe("compareBacklogCards — kind-aware backlog ordering", () => {
  it("floats task cards above issue cards", () => {
    const t = tc(task({ id: "t" }))
    const i = ic("/u/kobe", issue({ id: 1 }))
    expect(compareBacklogCards(t, i)).toBeLessThan(0)
    expect(compareBacklogCards(i, t)).toBeGreaterThan(0)
  })

  it("sorts issue cards newest-created first, then id desc", () => {
    const old = ic("/u/kobe", issue({ id: 1, created: "2026-06-01" }))
    const newA = ic("/u/kobe", issue({ id: 5, created: "2026-06-10" }))
    const newB = ic("/u/kobe", issue({ id: 3, created: "2026-06-10" }))
    const sorted = [old, newA, newB]
      .sort(compareBacklogCards)
      .map((c) => (c.kind === "issue" ? c.issue.id : 0))
    expect(sorted).toEqual([5, 3, 1])
  })

  it("delegates same-kind task ordering to compareCards (pinned floats)", () => {
    const pin = tc(task({ id: "p", pinned: true }))
    const reg = tc(task({ id: "r" }))
    expect(compareBacklogCards(pin, reg)).toBe(compareCards(task({ id: "p", pinned: true }), task({ id: "r" })))
  })
})

describe("buildBoard — Backlog mixes issues + backlog tasks", () => {
  it("puts issue cards in Backlog (always) regardless of any status field", () => {
    const board = buildBoard([
      tc(task({ id: "bt", status: "backlog" })),
      tc(task({ id: "ip", status: "in_progress" })),
      ic("/u/kobe", issue({ id: 1, status: "done" })), // issue status ignored
    ])
    const backlog = board.find((c) => c.key === "backlog")
    // Task card floats first, then the issue card.
    expect(backlog?.cards.map(cardId)).toEqual(["bt", "#1"])
    // The in_progress task is NOT in backlog.
    expect(
      board.find((c) => c.key === "in_progress")?.cards.map(cardId),
    ).toEqual(["ip"])
  })

  it("issue cards never land in a non-Backlog column", () => {
    const board = buildBoard([ic("/u/kobe", issue({ id: 1 }))])
    for (const col of board) {
      if (col.key === "backlog") continue
      expect(col.cards).toEqual([])
    }
  })
})

describe("buildProjectBoards — one board per project, deduped", () => {
  it("derives projects from the UNION of issue-repos and task-repos", () => {
    const allTasks = [task({ id: "t1", repo: "/u/web", status: "in_progress" })]
    const boards = buildProjectBoards(
      [
        ...allTasks.map(tc),
        ic("/u/kobe", issue({ id: 1 })), // issue-only project
      ],
      allTasks,
    )
    expect(boards.map((b) => b.repo).sort()).toEqual(["/u/kobe", "/u/web"])
    // Each project's columns are independent.
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(kobe?.columns.find((c) => c.key === "backlog")?.cards).toHaveLength(1)
  })

  it("hides an issue whose taskId points to a LIVE task (the task represents it)", () => {
    // Dedup is one-way now: the ISSUE carries taskId, the task knows nothing.
    const allTasks = [
      task({ id: "t1", repo: "/u/kobe", status: "in_progress" }),
    ]
    const boards = buildProjectBoards(
      [
        ...allTasks.map(tc),
        ic("/u/kobe", issue({ id: 1, taskId: "t1" })), // linked + live → hidden
        ic("/u/kobe", issue({ id: 2 })), // unlinked → shown in backlog
      ],
      allTasks,
    )
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(kobe?.columns.find((c) => c.key === "backlog")?.cards.map(cardId)).toEqual([
      "#2",
    ])
    // The live task represents issue #1 in in_progress.
    expect(
      kobe?.columns.find((c) => c.key === "in_progress")?.cards.map(cardId),
    ).toEqual(["t1"])
  })

  it("resurfaces an issue whose linked task is dead", () => {
    // taskId still points at t1, but t1 reached `done` → not live → resurface.
    const deadTasks = [task({ id: "t1", repo: "/u/kobe", status: "done" })]
    const boards = buildProjectBoards(
      [
        // the done task IS a board card (lands in done), issue resurfaces
        ...deadTasks.map(tc),
        ic("/u/kobe", issue({ id: 1, taskId: "t1" })),
      ],
      deadTasks,
    )
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    // Issue #1 is back in Backlog because its task is no longer live.
    expect(
      kobe?.columns.find((c) => c.key === "backlog")?.cards.map(cardId),
    ).toEqual(["#1"])
  })

  it("resurfaces an issue whose linked task was archived", () => {
    // An archived task is not live even mid-flight → its issue comes back. The
    // archived task is not a board card (isBoardTask drops it), so Backlog is
    // just the resurfaced issue.
    const archivedTasks = [
      task({ id: "t1", repo: "/u/kobe", status: "in_progress", archived: true }),
    ]
    const boards = buildProjectBoards(
      [
        ...archivedTasks.map(tc),
        ic("/u/kobe", issue({ id: 1, taskId: "t1" })),
      ],
      archivedTasks,
    )
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(
      kobe?.columns.find((c) => c.key === "backlog")?.cards.map(cardId),
    ).toEqual(["#1"])
  })

  it("dedups against the FULL task list even when the live task isn't a passed card", () => {
    // A project filter might exclude the live task card from `cards`, but the
    // issue must STILL hide (dedup reads allTasks, not the rendered cards).
    const allTasks = [
      task({ id: "t1", repo: "/u/kobe", status: "in_progress" }),
    ]
    const boards = buildProjectBoards(
      [ic("/u/kobe", issue({ id: 1, taskId: "t1" }))], // task card omitted from render set
      allTasks,
    )
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(kobe).toBeUndefined() // no visible cards → no project board
  })

  it("keeps an issue whose taskId points to a NONEXISTENT task", () => {
    // A stale link to a task that's gone from the list must not vanish the
    // issue — only a LIVE task suppresses it.
    const boards = buildProjectBoards(
      [ic("/u/kobe", issue({ id: 1, taskId: "ghost" }))],
      [],
    )
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(
      kobe?.columns.find((c) => c.key === "backlog")?.cards.map(cardId),
    ).toEqual(["#1"])
  })

  it("sorts projects by label", () => {
    const allTasks: Task[] = []
    const boards = buildProjectBoards(
      [
        ic("/u/proj/zeta", issue({ id: 1 })),
        ic("/u/proj/alpha", issue({ id: 1 })),
      ],
      allTasks,
    )
    expect(boards.map((b) => b.label)).toEqual(["alpha", "zeta"])
  })
})

describe("statusFilter composes with issue cards (matchesStatusFilter)", () => {
  // An issue card has no engine state or worktree changes. matchesStatusFilter
  // must not throw on the undefined inputs: "all" keeps it, every attention
  // bucket except "quiet" drops it (a bodiless idle issue triages as quiet).
  it('"all" shows issue cards; non-quiet attention chips hide them', () => {
    expect(matchesStatusFilter(undefined, undefined, "all")).toBe(true)
    expect(matchesStatusFilter(undefined, undefined, "attention")).toBe(false)
    expect(matchesStatusFilter(undefined, undefined, "working")).toBe(false)
    expect(matchesStatusFilter(undefined, undefined, "changes")).toBe(false)
    expect(matchesStatusFilter(undefined, undefined, "quiet")).toBe(true)
  })

  it("a board predicate ANDs repo + status, keeping issues under 'all'", () => {
    // Reconstruct the unified board's render predicate over a tiny fixture:
    // task cards triage by their engine state, issue cards by (undefined,
    // undefined). The "all" chip must leave issue cards visible.
    const running: EngineState = { state: "running" } as EngineState
    const fixture: BoardCard[] = [
      tc(task({ id: "t1", repo: "/u/kobe", status: "in_progress" })),
      ic("/u/kobe", issue({ id: 9 })),
    ]
    const engines: Record<string, EngineState | undefined> = { t1: running }
    const visible = (filter: "all" | "working"): string[] =>
      fixture
        .filter((c) =>
          c.kind === "task"
            ? matchesStatusFilter(engines[c.id], undefined, filter)
            : matchesStatusFilter(undefined, undefined, filter),
        )
        .map(cardId)

    expect(visible("all")).toEqual(["t1", "#9"]) // both
    expect(visible("working")).toEqual(["t1"]) // issue drops, task stays
  })
})
