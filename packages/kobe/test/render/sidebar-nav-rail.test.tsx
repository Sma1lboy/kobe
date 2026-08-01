/** @jsxImportSource @opentui/react */
/**
 * The sidebar's top-level rail renders VERTICALLY — one destination per line.
 *
 * Asserted against a real frame rather than the component tree because the
 * requirement is a layout one: at 24 cells the labels only fit stacked, and a
 * regression to `flexDirection="row"` would still type-check, still render
 * every label, and still pass a props-level test — it would just silently
 * truncate. Only the frame can tell the difference.
 */

import { expect, test } from "bun:test"
import { SidebarPanel } from "../../src/tui-react/panes/sidebar/panel"
import { SIDEBAR_NAV_ITEMS, cycleNavTarget, navShowsTaskList } from "../../src/tui/panes/sidebar/nav-core"
import { renderComponent } from "./harness"

const NOOP = (): void => {}

function panel(overrides: Partial<Parameters<typeof SidebarPanel>[0]> = {}) {
  return (
    <SidebarPanel
      rootRef={NOOP}
      focused={true}
      view="active"
      setView={NOOP}
      nav="workspace"
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
  for (const label of ["Workspace", "Kanban", "Automations", "Issues"]) {
    const index = lines.findIndex((line) => line.includes(label))
    if (index >= 0) out[label] = index
  }
  return out
}

test("every destination gets its own line", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
  const lines = await labelLines(frame)

  expect(Object.keys(lines).sort()).toEqual(["Automations", "Issues", "Kanban", "Workspace"])
  // Distinct rows — a horizontal strip would put several on one line, and at
  // 24 cells "Workspace Kanban Automations" cannot fit without truncation.
  const rows = Object.values(lines)
  expect(new Set(rows).size).toBe(rows.length)
})

test("the rail keeps its declared top-to-bottom order", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
  const lines = await labelLines(frame)

  const rendered = Object.entries(lines)
    .sort(([, a], [, b]) => a - b)
    .map(([label]) => label)
  expect(rendered).toEqual(["Workspace", "Kanban", "Automations", "Issues"])
})

test("no label is truncated at the 24-cell rail width", async () => {
  const { frame } = await renderComponent(panel(), { width: 24, height: 40 })
  const text = await frame()
  // "Automations" is the longest; an ellipsis or a clipped tail means the
  // layout went back to sharing a row.
  expect(text).toContain("Automations")
  expect(text).not.toContain("Automat…")
})

test("Archives shows under Workspace and disappears elsewhere", async () => {
  // Archives filters the task list; it is not a peer destination. It has no
  // meaning while a full-page surface is up.
  const inWorkspace = await renderComponent(panel({ nav: "workspace" }), { width: 24, height: 40 })
  expect(await inWorkspace.frame()).toContain("Archives")

  const inAutomations = await renderComponent(panel({ nav: "automations" }), { width: 24, height: 40 })
  expect(await inAutomations.frame()).not.toContain("Archives")
})

test("nav-core cycling wraps in both directions", () => {
  expect(cycleNavTarget("workspace", 1)).toBe("kanban")
  expect(cycleNavTarget("issues", 1)).toBe("workspace")
  expect(cycleNavTarget("workspace", -1)).toBe("issues")
  expect(cycleNavTarget("bogus" as never, 1)).toBeNull()
})

test("only Workspace carries the task list", () => {
  expect(navShowsTaskList("workspace")).toBe(true)
  for (const item of SIDEBAR_NAV_ITEMS.filter((i) => i.nav !== "workspace")) {
    expect(navShowsTaskList(item.nav)).toBe(false)
  }
})
