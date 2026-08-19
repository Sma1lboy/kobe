/** @jsxImportSource @opentui/react */
/**
 * The tree's right-click menu, driven by a REAL right-click through the
 * renderer.
 *
 * This file exists because the risky part of the feature is not the menu — it
 * is the assumption that button 2 survives the mouse pipeline at all. Asserting
 * on a menu rendered from directly-called state would prove nothing about that.
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

const MAIN = task("m", { kind: "main", branch: "", worktreePath: "/repos/kobe" })
const SETTLE = 80
const settle = () => new Promise((r) => setTimeout(r, SETTLE))
const RIGHT = 2

function tree(over: Partial<Parameters<typeof SidebarTree>[0]> = {}) {
  return (
    <SidebarTree
      tasks={[MAIN, task("a"), task("b")]}
      selectedId="a"
      selectedTabId={null}
      onSelect={() => {}}
      focused={true}
      width={40}
      {...over}
    />
  )
}

/** Screen row of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const at = text.split("\n").findIndex((line) => line.includes(needle))
  expect(at).toBeGreaterThan(-1)
  return at
}

test("right-click on a worktree row opens that row's menu", async () => {
  tabsByTask.clear()
  const { frame, mockMouse } = await renderComponent(tree(), { width: 40, height: 24 })
  await settle()
  const before = await frame()
  expect(before).not.toContain("Rename")

  await mockMouse.click(2, lineOf(before, "feat/a"), RIGHT)
  await settle()

  const after = await frame()
  expect(after).toContain("Open")
  expect(after).toContain("Rename")
  expect(after).toContain("Archive")
  expect(after).toContain("Delete")
})

test("a menu entry fires the row's real callback", async () => {
  tabsByTask.clear()
  const renamed: string[] = []
  const { frame, mockMouse, mockInput } = await renderComponent(tree({ onRenameRequest: (id) => renamed.push(id) }), {
    width: 40,
    height: 24,
  })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "feat/a"), RIGHT)
  await settle()

  // Highlight starts on "Open"; j steps to "Rename".
  mockInput.typeText("j")
  await settle()
  mockInput.pressEnter()
  await settle()

  expect(renamed).toEqual(["a"])
  // The menu closes on pick — leaving it up under a rename prompt would read
  // as two live surfaces. ("Delete", not "Archive": the Archives view tab is
  // permanent chrome and would match either way.)
  expect(await frame()).not.toContain("Delete")
})

test("escape closes the menu and hands j/k back to the tree", async () => {
  tabsByTask.clear()
  const chosen: string[] = []
  const { frame, mockMouse, mockInput } = await renderComponent(tree({ onSelect: (id) => chosen.push(id) }), {
    width: 40,
    height: 24,
  })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "feat/a"), RIGHT)
  await settle()
  expect(await frame()).toContain("Rename")

  mockInput.pressEscape()
  await settle()
  expect(await frame()).not.toContain("Rename")

  // j/k are the TREE's again — while the menu was up they moved its highlight.
  mockInput.typeText("j")
  await settle()
  mockInput.pressEnter()
  await settle()
  expect(chosen).toEqual(["b"])
})

test("right-click on a project header offers the project's own actions", async () => {
  tabsByTask.clear()
  const { frame, mockMouse } = await renderComponent(tree(), { width: 40, height: 24 })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "kobe"), RIGHT)
  await settle()

  const after = await frame()
  expect(after).toContain("New task")
  // A project is not a checkout — no per-task verbs on its header.
  expect(after).not.toContain("Delete")
})

test("left-click still activates the row it lands on", async () => {
  // The right-click branch lives inside the row's existing onMouseUp, so a
  // regression here would silently kill click-to-switch.
  tabsByTask.clear()
  const chosen: string[] = []
  const { frame, mockMouse } = await renderComponent(tree({ onSelect: (id) => chosen.push(id) }), {
    width: 40,
    height: 24,
  })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "feat/b"), 0)
  await settle()

  expect(chosen).toEqual(["b"])
})

/** Seed a task with N tabs so the tab rows render. */
function seedTabs(taskId: string, tabIds: readonly string[]): void {
  tabsByTask.set(taskId, {
    tabs: tabIds.map((id, i) => ({ kind: "engine" as const, id, title: `tab ${i + 1}`, ordinal: i + 1 })),
    activeId: tabIds[0] ?? "tab-1",
    nextOrdinal: tabIds.length + 1,
  })
}

test("a tab row's menu closes that tab, naming the (task, tab) pair", async () => {
  tabsByTask.clear()
  seedTabs("a", ["tab-1", "tab-2"])
  const closed: Array<[string, string]> = []
  const { frame, mockMouse, mockInput } = await renderComponent(
    tree({ onCloseTab: (taskId, tabId) => closed.push([taskId, tabId]) }),
    { width: 40, height: 24 },
  )
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "tab 2"), RIGHT)
  await settle()
  expect(await frame()).toContain("Close tab")

  // Highlight starts on "Open tab"; j steps to "Close tab".
  mockInput.typeText("j")
  await settle()
  mockInput.pressEnter()
  await settle()

  expect(closed).toEqual([["a", "tab-2"]])
})

test("a worktree's LAST tab offers no close", async () => {
  // The refusal lives in closeTab core; the menu just doesn't offer what
  // would be refused.
  tabsByTask.clear()
  seedTabs("a", ["tab-1"])
  const { frame, mockMouse } = await renderComponent(tree(), { width: 40, height: 24 })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "tab 1"), RIGHT)
  await settle()

  const after = await frame()
  expect(after).toContain("Open tab")
  expect(after).not.toContain("Close tab")
})

/** Screen position of the first occurrence of `needle`. */
function posOf(text: string, needle: string): { x: number; y: number } {
  const y = lineOf(text, needle)
  const x = (text.split("\n")[y] ?? "").indexOf(needle)
  return { x, y }
}

test("a press anywhere else dismisses the menu", async () => {
  // The whole point of the feature: the menu is not a mode you have to shoot
  // down by re-clicking the row it came from.
  tabsByTask.clear()
  const { frame, mockMouse } = await renderComponent(tree(), { width: 40, height: 24 })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "feat/a"), RIGHT)
  await settle()
  expect(await frame()).toContain("Rename")

  // Empty space below the last row — no row handler runs, so only the
  // root-level dismiss can close it.
  await mockMouse.click(2, 22, 0)
  await settle()
  expect(await frame()).not.toContain("Rename")
})

test("a press ON the menu still picks its entry", async () => {
  // The dismiss listener must not eat the menu's own press: the pick lands on
  // the mouse-UP, so a menu closed by the DOWN would never fire anything.
  tabsByTask.clear()
  const renamed: string[] = []
  const { frame, mockMouse } = await renderComponent(tree({ onRenameRequest: (id) => renamed.push(id) }), {
    width: 40,
    height: 24,
  })
  await settle()
  await mockMouse.click(2, lineOf(await frame(), "feat/a"), RIGHT)
  await settle()

  const entry = posOf(await frame(), "Rename")
  await mockMouse.click(entry.x, entry.y, 0)
  await settle()

  expect(renamed).toEqual(["a"])
  expect(await frame()).not.toContain("Delete")
})
