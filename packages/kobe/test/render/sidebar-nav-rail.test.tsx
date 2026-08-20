/** @jsxImportSource @opentui/react */
/**
 * The sidebar's rail renders VERTICALLY — one destination per line — and the
 * task list stays put underneath it whatever the rail selects.
 *
 * Asserted against a real frame rather than the component tree because both
 * requirements are layout ones: a regression to `flexDirection="row"` would
 * still type-check, still render every label, and still pass a props-level
 * test — it would just silently truncate at 24 cells. Only the frame knows.
 */

import { expect, test } from "bun:test"
import { SidebarTree } from "../../src/tui-react/panes/sidebar/SidebarTree"
import { SIDEBAR_NAV_ITEMS, cycleNavTarget, focusPaneForNav } from "../../src/tui/panes/sidebar/nav-core"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

const SETTLE = 80

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/rove",
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

const MAIN = task("m", { kind: "main", branch: "", worktreePath: "/repos/rove" })

function tree(over: Partial<Parameters<typeof SidebarTree>[0]> = {}) {
  return (
    <SidebarTree
      tasks={[MAIN, task("a"), task("b")]}
      selectedId="a"
      selectedTabId={null}
      onSelect={() => {}}
      focused={true}
      width={24}
      {...over}
    />
  )
}

/** Which frame line each rail label landed on. */
async function labelLines(frame: () => Promise<string>): Promise<Record<string, number>> {
  const lines = (await frame()).split("\n")
  const out: Record<string, number> = {}
  for (const label of ["Kanban", "Routines"]) {
    const index = lines.findIndex((line) => line.includes(label))
    if (index >= 0) out[label] = index
  }
  return out
}

test("every destination gets its own line, in declared order", async () => {
  const { frame } = await renderComponent(tree(), { width: 24, height: 40 })
  await new Promise((r) => setTimeout(r, SETTLE))
  const lines = await labelLines(frame)

  const rendered = Object.entries(lines)
    .sort(([, a], [, b]) => a - b)
    .map(([label]) => label)
  expect(rendered).toEqual(["Kanban", "Routines"])
  // Distinct rows — a horizontal strip would share lines.
  expect(new Set(Object.values(lines)).size).toBe(2)
})

test("no label is truncated at the 24-cell rail width", async () => {
  const { frame } = await renderComponent(tree(), { width: 24, height: 40 })
  await new Promise((r) => setTimeout(r, SETTLE))
  const text = await frame()
  expect(text).toContain("Routines")
  expect(text).not.toContain("Routin…")
})

test("the rail has no row for the terminal — the task list IS that destination", async () => {
  const { frame } = await renderComponent(tree(), { width: 24, height: 40 })
  await new Promise((r) => setTimeout(r, SETTLE))
  const text = await frame()
  // A "Workspace"/"Terminal" row would be a second control for what selecting
  // a task already does.
  expect(text).not.toContain("Workspace")
  expect(SIDEBAR_NAV_ITEMS.some((item) => item.nav === "terminal")).toBe(false)
})

test("the task list stays visible whatever the rail selects", async () => {
  // The rail swaps the CONTENT pane on the right; the sidebar is unchanged, so
  // clicking a task while the Kanban is up can switch back to its terminal.
  for (const nav of ["terminal", "kanban", "automations", "issues"] as const) {
    const { frame } = await renderComponent(tree({ nav }), { width: 24, height: 40 })
    await new Promise((r) => setTimeout(r, SETTLE))
    expect(await frame(), nav).toContain("feat/a")
  }
})

test("nav-core cycling wraps in both directions", () => {
  expect(cycleNavTarget("kanban", 1)).toBe("automations")
  expect(cycleNavTarget("automations", 1)).toBe("kanban")
  expect(cycleNavTarget("kanban", -1)).toBe("automations")
  // Neither `terminal` nor the hidden `issues` page is on the rail, so there
  // is nowhere to cycle from either.
  expect(cycleNavTarget("terminal", 1)).toBeNull()
  expect(cycleNavTarget("issues", 1)).toBeNull()
})

test("opening a rail page carries focus into the content pane", () => {
  // The pages gate their own keys on being focused. Without this the
  // Automations page rendered "Press n to create one" while `n` still went to
  // the sidebar's new-task chord.
  expect(focusPaneForNav("kanban")).toBe("workspace")
  expect(focusPaneForNav("automations")).toBe("workspace")
  expect(focusPaneForNav("issues")).toBe("workspace")
  // Back to the terminal means back to the task list.
  expect(focusPaneForNav("terminal")).toBe("sidebar")
})
