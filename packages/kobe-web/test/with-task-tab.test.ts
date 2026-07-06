import { describe, expect, it } from "vitest"
import type { TabsState, WorkspaceTab } from "../src/lib/tabs.ts"
import { withTaskTab } from "../src/lib/tabs.ts"


const tab = (id: string, kind: WorkspaceTab["kind"] = "vendor"): WorkspaceTab =>
  ({ id, kind, title: id }) as WorkspaceTab

const base = (over: Partial<TabsState>): TabsState => ({
  selectedTaskId: "t",
  tabsByTask: {},
  activeByTask: {},
  splitByTask: {},
  ...over,
})

describe("withTaskTab", () => {
  it("mints an empty tab + makes it active for a task with no tabs", () => {
    const out = withTaskTab(base({}), "t")
    expect(out.tabsByTask.t).toHaveLength(1)
    expect(out.tabsByTask.t[0].kind).toBe("empty")
    expect(out.activeByTask.t).toBe(out.tabsByTask.t[0].id)
  })

  it("leaves a consistent slice untouched (same reference)", () => {
    const state = base({
      tabsByTask: { t: [tab("a"), tab("b")] },
      activeByTask: { t: "a" },
    })
    expect(withTaskTab(state, "t")).toBe(state)
  })

  it("falls back to the first tab when the active id is missing", () => {
    const out = withTaskTab(
      base({
        tabsByTask: { t: [tab("a"), tab("b")] },
        activeByTask: { t: "ghost" },
      }),
      "t",
    )
    expect(out.activeByTask.t).toBe("a")
  })

  it("drops a split that points at a closed tab", () => {
    const out = withTaskTab(
      base({
        tabsByTask: { t: [tab("a"), tab("b")] },
        activeByTask: { t: "a" },
        splitByTask: { t: "gone" },
      }),
      "t",
    )
    expect(out.splitByTask.t).toBeUndefined()
  })

  it("drops a split that equals the active tab (no self-split)", () => {
    const out = withTaskTab(
      base({
        tabsByTask: { t: [tab("a"), tab("b")] },
        activeByTask: { t: "a" },
        splitByTask: { t: "a" },
      }),
      "t",
    )
    expect(out.splitByTask.t).toBeUndefined()
  })

  it("keeps a valid split that differs from the active tab", () => {
    const state = base({
      tabsByTask: { t: [tab("a"), tab("b")] },
      activeByTask: { t: "a" },
      splitByTask: { t: "b" },
    })
    expect(withTaskTab(state, "t").splitByTask.t).toBe("b")
    expect(withTaskTab(state, "t")).toBe(state)
  })

  it("does not touch other tasks' slices", () => {
    const out = withTaskTab(
      base({
        tabsByTask: { t: [], other: [tab("x")] },
        activeByTask: { other: "x" },
      }),
      "t",
    )
    expect(out.tabsByTask.other).toEqual([tab("x")])
    expect(out.activeByTask.other).toBe("x")
  })
})
