/** @jsxImportSource @opentui/react */
/**
 * The tree sidebar's rows render and its keys actually fire.
 *
 * Every assertion here presses a real key rather than checking a static
 * frame, because the failure this file exists to catch is a binding that was
 * never registered: the Automations page shipped with every one of its keys
 * dead (a `Binding[]` passed as an object literal), and a frame-only test
 * stayed green through it. A tree whose j/k/enter silently do nothing looks
 * exactly like a tree that renders correctly.
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

test("renders project header, worktree cards, and tab rows", async () => {
  seedTabs("a", ["tab-1", "tab-2"])
  const { frame } = await renderComponent(tree(), { width: 28, height: 24 })
  await new Promise((r) => setTimeout(r, SETTLE))
  const text = await frame()

  // The project header keeps the flat sidebar's section-header grammar —
  // label + divider run — with a twisty in front (round 2: the tree reuses
  // the original design language rather than inventing a one-line grammar).
  expect(text).toContain("▾ kobe")
  expect(text).toContain("─")
  // Worktrees are the same two-line cards; their branch is the subtitle.
  expect(text).toContain("feat/a")
  expect(text).toContain("feat/b")
  // The selected worktree starts expanded, so its tabs are visible without a
  // keystroke — that is the whole point of replacing the strip.
  expect(text).toContain("tab 1")
  expect(text).toContain("tab 2")

  const lines = text.split("\n")
  const indentOf = (needle: string): number => {
    const line = lines.find((l) => l.includes(needle)) ?? ""
    return line.indexOf(needle)
  }
  // A tab row reads as a CHILD of its card: one level right of the card's
  // subtitle column. (Cards and section headers share the left edge — that
  // is the flat sidebar's own grammar, unchanged.)
  expect(indentOf("tab 1")).toBeGreaterThan(indentOf("feat/a"))
})

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

test("h collapses the worktree under the cursor and l expands it again", async () => {
  seedTabs("a", ["tab-1"])
  const { frame, mockInput } = await renderComponent(tree(), { width: 28, height: 20 })
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("tab 1")

  mockInput.typeText("h")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).not.toContain("tab 1")

  mockInput.typeText("l")
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("tab 1")
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

test("/ opens the query row and prunes the tree to matches plus ancestors", async () => {
  tabsByTask.clear()
  const tasks = [MAIN, task("a", { title: "alpha" }), task("b", { title: "bravo" })]
  const { frame, mockInput } = await renderComponent(tree({ tasks }), { width: 28, height: 20 })
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("feat/a")

  mockInput.typeText("/")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("bravo")
  await new Promise((r) => setTimeout(r, SETTLE))

  const text = await frame()
  // The query row echoes what you typed…
  expect(text).toContain("/bravo")
  // …the match survives, its sibling does not, and the project header stays
  // so the hit is not left floating.
  expect(text).toContain("feat/b")
  expect(text).not.toContain("feat/a")
  expect(text).toContain("kobe")
})

test("the query matches a live TAB title, which no task-title search could", async () => {
  // The tree's own increment over the flat sidebar: "which tab is running
  // that thing" is answerable, and the answer drags its worktree along.
  seedTabsNamed("a", [["tab-1", "zebra-tab"]])
  const { frame, mockInput } = await renderComponent(tree(), { width: 28, height: 20 })
  await new Promise((r) => setTimeout(r, SETTLE))

  mockInput.typeText("/")
  await new Promise((r) => setTimeout(r, SETTLE))
  mockInput.typeText("zebra")
  await new Promise((r) => setTimeout(r, SETTLE))

  const text = await frame()
  expect(text).toContain("zebra-tab")
  expect(text).toContain("feat/a")
  expect(text).not.toContain("feat/b")
})

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

test("ctrl+p folds every project but the cursor's, and unfolds on a second press", async () => {
  tabsByTask.clear()
  const tasks = [MAIN, task("a"), task("x", { repo: "/repos/foxychat", branch: "feat/x" })]
  const { frame, mockInput } = await renderComponent(tree({ tasks }), { width: 28, height: 20 })
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("feat/x")

  // Cursor sits on `a` (the selected task), which lives in /repos/kobe.
  mockInput.pressKey("p", { ctrl: true })
  await new Promise((r) => setTimeout(r, SETTLE))
  const focused = await frame()
  expect(focused).not.toContain("feat/x")
  // The header stays — this is a fold, not a filter, so the other projects
  // are still there to open.
  expect(focused).toContain("foxychat")
  expect(focused).toContain("feat/a")

  mockInput.pressKey("p", { ctrl: true })
  await new Promise((r) => setTimeout(r, SETTLE))
  expect(await frame()).toContain("feat/x")
})
