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
import { SidebarPanel } from "../../src/tui-react/panes/sidebar/panel"
import { SIDEBAR_NAV_ITEMS, cycleNavTarget } from "../../src/tui/panes/sidebar/nav-core"
import { renderComponent } from "./harness"

const NOOP = (): void => {}

function panel(overrides: Partial<Parameters<typeof SidebarPanel>[0]> = {}) {
  return (
    <SidebarPanel
      rootRef={NOOP}
      focused={true}
      view="active"
      setView={NOOP}
      nav="terminal"
      setNav={NOOP}
      sortMode="recent"
      searchMode={false}
      searchQuery=""
      flatIds={[]}
      totalRows={0}
      projectRows={[]}
      taskRows={[]}
      hasTaskRows={false}
      projectOptions={[]}
      projectFilterRepo={null}
      projectFilterLabel=""
      cycleProjectFilter={NOOP}
      projectScrollMaxHeight={10}
      setProjectScrollRef={NOOP}
      setTaskScrollRef={NOOP}
      rowCardShared={{} as Parameters<typeof SidebarPanel>[0]["rowCardShared"]}
      hover={null}
      dims={{ width: 24, height: 40 }}
      renderHoverFallback={false}
      {...overrides}
    />
  )
}

/** Which frame line each rail label landed on. */
async function labelLines(frame: () => Promise<string>): Promise<Record<string, number>> {
  const lines = (await frame()).split("\n")
  const out: Record<string, number> = {}
  for (const label of ["Kanban", "Automations", "Issues"]) {
    const index = lines.findIndex((line) => line.includes(label))
    if (index >= 0) out[label] = index
  }
  return out
}

test("every destination gets its own line, in declared order", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
  const lines = await labelLines(frame)

  const rendered = Object.entries(lines)
    .sort(([, a], [, b]) => a - b)
    .map(([label]) => label)
  expect(rendered).toEqual(["Kanban", "Automations", "Issues"])
  // Distinct rows — a horizontal strip would share lines.
  expect(new Set(Object.values(lines)).size).toBe(3)
})

test("no label is truncated at the 24-cell rail width", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
  const text = await frame()
  expect(text).toContain("Automations")
  expect(text).not.toContain("Automat…")
})

test("the rail has no row for the terminal — the task list IS that destination", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
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
    const { frame } = await renderComponent(panel({ nav }), { width: 24, height: 40 })
    const text = await frame()
    expect(text, nav).toContain("TASKS")
    expect(text, nav).toContain("Archives")
  }
})

test("nav-core cycling wraps in both directions", () => {
  expect(cycleNavTarget("kanban", 1)).toBe("automations")
  expect(cycleNavTarget("issues", 1)).toBe("kanban")
  expect(cycleNavTarget("kanban", -1)).toBe("issues")
  // `terminal` is not on the rail, so there is nowhere to cycle from.
  expect(cycleNavTarget("terminal", 1)).toBeNull()
})
