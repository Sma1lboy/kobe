/** @jsxImportSource @opentui/react */
/**
 * The frame goldens (`test/render/golden/*.frame.txt`) now lock what this
 * sidebar RENDERS — the project header, the per-level indent, the resting and
 * live state glyphs, the pruned search tree, the archived view row — as whole
 * captured frames rather than as substring probes that say nothing about the
 * cells they don't name. The cases that asserted those things were removed
 * here rather than kept as a weaker duplicate.
 *
 * What remains is this file's original reason to exist, which no frame can
 * cover: pressing a real key and proving the CALLBACK fired. The Automations
 * page once shipped with every one of its keys dead (a `Binding[]` passed as
 * an object literal) and a frame-only test stayed green through it — a tree
 * whose j/k/enter silently do nothing looks exactly like a tree that renders
 * correctly.
 */
import { expect, test } from "bun:test"
import { SidebarTree } from "../../src/tui-react/panes/sidebar/SidebarTree"
import { tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/kobe",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

/** Seed the module-level tab map the tree reads through `knownTaskTabs`. */
function seedTabs(taskId: string, tabIds: readonly string[]): void {
  tabsByTask.set(taskId, {
    tabs: tabIds.map((id, i) => ({ kind: "engine" as const, id, title: `tab ${i + 1}`, ordinal: i + 1 })),
    activeId: tabIds[0] ?? "tab-1",
    nextOrdinal: tabIds.length + 1,
  })
}

const MAIN = task("m", { kind: "main", branch: "", worktreePath: "/repos/kobe" })
const SETTLE = 80

function tree(over: Partial<Parameters<typeof SidebarTree>[0]> = {}) {
  return (
    <SidebarTree
      tasks={[MAIN, task("a"), task("b")]}
      selectedId="a"
      selectedTabId={null}
      onSelect={() => {}}
      focused={true}
      width={28}
      {...over}
    />
  )
}

test("enter on a tab row activates that tab, not just its task", async () => {
  seedTabs("a", ["tab-1", "tab-2"])
  const picked: Array<[string, string]> = []
  const { mockInput } = await renderComponent(tree({ onSelectTab: (taskId, tabId) => picked.push([taskId, tabId]) }), {
    width: 28,
    height: 20,
  })
  await new Promise((r) => setTimeout(r, SETTLE))

  // Cursor lands on the selected worktree; j steps onto its first tab row.
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.pressEnter()
  await new Promise((r) => setTimeout(r, SETTLE))

  expect(picked).toEqual([["a", "tab-1"]])
})

test("l on a tab row enters that tab's chat — there is no fold", async () => {
  // Owner call 2026-08-01 round 5: the tree never folds, so `l` is "go in".
  // On the last level (a tab row) that means entering the tab.
  seedTabs("a", ["tab-1", "tab-2"])
  const picked: Array<[string, string]> = []
  const { frame, mockInput } = await renderComponent(
    tree({ onSelectTab: (taskId, tabId) => picked.push([taskId, tabId]) }),
    { width: 28, height: 20 },
  )
  await new Promise((r) => setTimeout(r, SETTLE))
  // Tabs are visible without any keystroke…
  expect(await frame()).toContain("tab 1")

  // …h does nothing to them (no fold to drive)…
  mockInput.typeText("h")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("tab 1")

  // …and l on the tab row (j steps onto it) opens that tab.
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("l")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(picked).toEqual([["a", "tab-1"]])
})

test("j/k move the cursor over worktree rows", async () => {
  tabsByTask.clear()
  const chosen: string[] = []
  const { mockInput } = await renderComponent(tree({ onSelect: (id) => chosen.push(id) }), {
    width: 28,
    height: 20,
  })
  await new Promise((r) => setTimeout(r, SETTLE))

  // No tabs seeded, so every row is a worktree: m, a, b — cursor starts on
  // the selected `a`. `selectedId` is a fixed prop here (a real host would
  // re-render with the new one and the follow effect would re-anchor), so
  // the cursor moves freely: j lands on `b`, k returns to `a`.
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.pressEnter()
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("k")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.pressEnter()
  await new Promise((r) => setTimeout(r, SETTLE))

  // Two DIFFERENT ids — a cursor that never moved would report `a` twice.
  expect(chosen).toEqual(["b", "a"])
})

test("keys stay dead while another pane holds focus", async () => {
  // The tree binds bare j/k/h/l. Focused elsewhere it must not consume them —
  // the terminal pane needs them as text.
  seedTabs("a", ["tab-1"])
  const picked: string[] = []
  const { mockInput } = await renderComponent(tree({ focused: false, onSelect: (id) => picked.push(id) }), {
    width: 28,
    height: 20,
  })
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("j")
  mockInput.pressEnter()
  await new Promise((r) => setTimeout(r, SETTLE))

  expect(picked).toEqual([])
})

/** Seed tabs with explicit titles — the tab-title search needs a label that
 *  is nothing like its task's. */
function seedTabsNamed(taskId: string, tabs: ReadonlyArray<readonly [string, string]>): void {
  tabsByTask.set(taskId, {
    tabs: tabs.map(([id, title], i) => ({ kind: "engine" as const, id, title, ordinal: i + 1 })),
    activeId: tabs[0]?.[0] ?? "tab-1",
    nextOrdinal: tabs.length + 1,
  })
}

test("escape leaves search and restores the full tree", async () => {
  tabsByTask.clear()
  const tasks = [MAIN, task("a", { title: "alpha" }), task("b", { title: "bravo" })]
  const { frame, mockInput } = await renderComponent(tree({ tasks }), { width: 28, height: 20 })
  await new Promise((r) => setTimeout(r, SETTLE))

  mockInput.typeText("/")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("bravo")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).not.toContain("feat/a")

  mockInput.pressEscape()
  await new Promise((r) => setTimeout(r, SETTLE))
  const text = await frame()
  expect(text).toContain("feat/a")
  expect(text).not.toContain("/bravo")
})

// ─── Move mode is scope-aware (issue #43): the cursor row's LEVEL moves ───

test("move mode on a TASK row moves the task itself within its repo group", async () => {
  tabsByTask.clear()
  const moves: Array<[string, number]> = []
  const tasks = [MAIN, task("a"), task("x", { repo: "/repos/foxychat", branch: "feat/x" })]
  const { frame, mockInput } = await renderComponent(
    tree({ tasks, moveMode: true, onMoveRequest: (id, delta) => moves.push([id, delta]) }),
    { width: 28, height: 20 },
  )
  await new Promise((r) => setTimeout(r, SETTLE))

  // The cursor sits on `a` — a regular task, so j/k move IT (the repo-group
  // partition lives in moveTask), not its project's main.
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("k")
  await new Promise((r) => setTimeout(r, SETTLE))

  expect(moves).toEqual([
    ["a", 1],
    ["a", -1],
  ])
  // …the cursor did NOT walk (j/k belong to the drag), and the dragged ROW
  // wears the chip — not the project header.
  expect(await frame()).toContain(" move")
})

test("move mode on a MAIN row drags the whole project", async () => {
  // Project order is the mains' stored order, so moving the main IS moving
  // the group — the pre-#43 behavior, now scoped to the main row.
  tabsByTask.clear()
  const moves: Array<[string, number]> = []
  const tasks = [MAIN, task("a")]
  const { mockInput } = await renderComponent(
    tree({ tasks, selectedId: "m", moveMode: true, onMoveRequest: (id, delta) => moves.push([id, delta]) }),
    { width: 28, height: 20 },
  )
  await new Promise((r) => setTimeout(r, SETTLE))

  // Cursor anchors on the selected `m` (the repo's own checkout row).
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(moves).toEqual([["m", 1]])
})

test("move mode on a TAB row moves the tab within its task", async () => {
  seedTabs("a", ["tab-1", "tab-2"])
  const tabMoves: Array<[string, string, number]> = []
  const taskMoves: string[] = []
  const { mockInput } = await renderComponent(
    tree({
      selectedTabId: "tab-2",
      moveMode: true,
      onMoveRequest: (id) => taskMoves.push(id),
      onMoveTabRequest: (taskId, tabId, delta) => tabMoves.push([taskId, tabId, delta]),
    }),
    { width: 28, height: 20 },
  )
  await new Promise((r) => setTimeout(r, SETTLE))

  // The active row is a's tab-2 — the cursor anchors there, so j/k move the
  // TAB, and the task/project callbacks stay silent.
  mockInput.typeText("k")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("j")
  await new Promise((r) => setTimeout(r, SETTLE))

  expect(tabMoves).toEqual([
    ["a", "tab-2", -1],
    ["a", "tab-2", 1],
  ])
  expect(taskMoves).toEqual([])
})

test("escape leaves move mode", async () => {
  tabsByTask.clear()
  let exited = 0
  const { mockInput } = await renderComponent(tree({ moveMode: true, onMoveModeExit: () => exited++ }), {
    width: 28,
    height: 20,
  })
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.pressEscape()
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(exited).toBe(1)
})
