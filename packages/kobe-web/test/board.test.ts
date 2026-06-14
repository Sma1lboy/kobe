import { afterEach, describe, expect, it } from "vitest"
import {
  BOARD_COLUMNS,
  type BoardCard,
  boardCardCount,
  buildBoard,
  buildProjectBoards,
  compareCards,
  isLinkedIssue,
  issueColumnKey,
  labelRepo,
  TERMINAL_COLUMN_CAP,
} from "../src/lib/board.ts"
import {
  getBoardState,
  resetBoardStateForTest,
  setBoardQuery,
  setBoardRepo,
} from "../src/lib/board-state.ts"
import type { Issue } from "../src/lib/types.ts"

/**
 * Issues-only kanban column math. The load-bearing rules: the board renders
 * ISSUES only (no task cards); each issue lands by its OWN lifecycle —
 * Done = `done`, In progress = linked to a task (`taskId` set), Backlog =
 * everything else (open / hold / unlinked); within a column newest-created
 * first; Done is capped.
 */

const issue = (over: Partial<Issue>): Issue => ({
  id: over.id ?? 1,
  title: "",
  status: "open",
  created: "2026-06-01",
  body: "",
  ...over,
})

/** An issue card for `repo`. */
const ic = (repo: string, i: Issue): BoardCard => ({ repo, issue: i })

const columnKeys = (cards: BoardCard[]) => buildBoard(cards).map((c) => c.key)
/** Issue ids in a column, as `#<id>`. */
const cardId = (c: BoardCard): string => `#${c.issue.id}`
const columnIds = (cards: BoardCard[], key: string) =>
  buildBoard(cards)
    .find((c) => c.key === key)
    ?.cards.map(cardId)

describe("issueColumnKey — lifecycle placement", () => {
  it("a done issue → Done (even if it still carries a stale taskId)", () => {
    expect(issueColumnKey(issue({ status: "done" }))).toBe("done")
    expect(issueColumnKey(issue({ status: "done", taskId: "t1" }))).toBe("done")
  })

  it("a linked (started) issue → In progress", () => {
    expect(issueColumnKey(issue({ status: "open", taskId: "t1" }))).toBe(
      "in_progress",
    )
    expect(issueColumnKey(issue({ status: "doing", taskId: "t1" }))).toBe(
      "in_progress",
    )
    expect(issueColumnKey(issue({ status: "hold", taskId: "t1" }))).toBe(
      "in_progress",
    )
  })

  it("open / hold / unlinked issues → Backlog", () => {
    expect(issueColumnKey(issue({ status: "open" }))).toBe("backlog")
    expect(issueColumnKey(issue({ status: "hold" }))).toBe("backlog")
    expect(issueColumnKey(issue({ status: "doing" }))).toBe("backlog")
    // An empty-string taskId is not a real link.
    expect(issueColumnKey(issue({ status: "open", taskId: "" }))).toBe(
      "backlog",
    )
  })
})

describe("isLinkedIssue — drives the open-task affordance", () => {
  it("true only for an issue with a non-empty taskId", () => {
    expect(isLinkedIssue(issue({ taskId: "t1" }))).toBe(true)
    expect(isLinkedIssue(issue({}))).toBe(false)
    expect(isLinkedIssue(issue({ taskId: "" }))).toBe(false)
  })
})

describe("buildBoard — column visibility", () => {
  it("always shows the three lifecycle columns, even when empty", () => {
    expect(columnKeys([])).toEqual(["backlog", "in_progress", "done"])
  })

  it("keeps canonical order per BOARD_COLUMNS", () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual([
      "backlog",
      "in_progress",
      "done",
    ])
  })
})

describe("buildBoard — bucketing by issue lifecycle", () => {
  it("places each issue into its lifecycle column", () => {
    const cards = [
      ic("/u/k", issue({ id: 1, status: "open" })), // backlog
      ic("/u/k", issue({ id: 2, status: "hold" })), // backlog
      ic("/u/k", issue({ id: 3, status: "open", taskId: "t3" })), // in_progress
      ic("/u/k", issue({ id: 4, status: "done" })), // done
    ]
    expect(columnIds(cards, "backlog")).toEqual(["#2", "#1"])
    expect(columnIds(cards, "in_progress")).toEqual(["#3"])
    expect(columnIds(cards, "done")).toEqual(["#4"])
  })

  it("an unlinked done issue still lands in Done, not Backlog", () => {
    expect(columnIds([ic("/u/k", issue({ id: 9, status: "done" }))], "done")).toEqual(
      ["#9"],
    )
  })
})

describe("compareCards — within a column", () => {
  it("sorts newest-created first, then id desc as the tiebreak", () => {
    const old = ic("/u/k", issue({ id: 1, created: "2026-06-01" }))
    const newA = ic("/u/k", issue({ id: 5, created: "2026-06-10" }))
    const newB = ic("/u/k", issue({ id: 3, created: "2026-06-10" }))
    const sorted = [old, newA, newB].sort(compareCards).map(cardId)
    expect(sorted).toEqual(["#5", "#3", "#1"])
  })
})

describe("buildBoard — Done column cap (R1 growth policy)", () => {
  it("caps Done at TERMINAL_COLUMN_CAP with a hidden count; active columns uncapped", () => {
    const done = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      ic("/u/k", issue({ id: 1000 + i, status: "done" })),
    )
    const active = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      ic("/u/k", issue({ id: 2000 + i, status: "open", taskId: `t${i}` })),
    )
    const board = buildBoard([...done, ...active])
    const doneCol = board.find((c) => c.key === "done")
    const activeCol = board.find((c) => c.key === "in_progress")
    expect(doneCol?.cards).toHaveLength(TERMINAL_COLUMN_CAP)
    expect(doneCol?.hiddenCount).toBe(5)
    expect(activeCol?.cards).toHaveLength(TERMINAL_COLUMN_CAP + 5)
    expect(activeCol?.hiddenCount).toBe(0)
  })
})

describe("boardCardCount", () => {
  it("totals the rendered cards across columns (excludes the hidden cap)", () => {
    const cards = [
      ic("/u/k", issue({ id: 1, status: "open" })),
      ic("/u/k", issue({ id: 2, status: "open", taskId: "t2" })),
      ic("/u/k", issue({ id: 3, status: "done" })),
    ]
    expect(boardCardCount(buildBoard(cards))).toBe(3)
  })
})

describe("buildProjectBoards — one board per project (issues only)", () => {
  it("derives projects from the distinct issue-repos", () => {
    const boards = buildProjectBoards([
      ic("/u/web", issue({ id: 1, status: "open", taskId: "t1" })),
      ic("/u/kobe", issue({ id: 2, status: "open" })),
    ])
    expect(boards.map((b) => b.repo).sort()).toEqual(["/u/kobe", "/u/web"])
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(
      kobe?.columns.find((c) => c.key === "backlog")?.cards,
    ).toHaveLength(1)
    const web = boards.find((b) => b.repo === "/u/web")
    expect(
      web?.columns.find((c) => c.key === "in_progress")?.cards.map(cardId),
    ).toEqual(["#1"])
  })

  it("ALWAYS shows a linked issue (no task-card dedup any more)", () => {
    // The old unified board hid an issue behind its live task card; the
    // issues-only board never hides it — a linked issue just moves to
    // In progress and keeps its open-task affordance.
    const boards = buildProjectBoards([
      ic("/u/kobe", issue({ id: 1, status: "open", taskId: "t1" })),
      ic("/u/kobe", issue({ id: 2, status: "open" })),
    ])
    const kobe = boards.find((b) => b.repo === "/u/kobe")
    expect(
      kobe?.columns.find((c) => c.key === "in_progress")?.cards.map(cardId),
    ).toEqual(["#1"])
    expect(
      kobe?.columns.find((c) => c.key === "backlog")?.cards.map(cardId),
    ).toEqual(["#2"])
  })

  it("sorts projects by label", () => {
    const boards = buildProjectBoards([
      ic("/u/proj/zeta", issue({ id: 1 })),
      ic("/u/proj/alpha", issue({ id: 1 })),
    ])
    expect(boards.map((b) => b.label)).toEqual(["alpha", "zeta"])
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

  it("composes the repo chip with the text query (AND)", () => {
    setBoardRepo("/u/kobe")
    setBoardQuery("auth")
    expect(getBoardState().repo).toBe("/u/kobe")
    expect(getBoardState().query).toBe("auth")
  })
})
