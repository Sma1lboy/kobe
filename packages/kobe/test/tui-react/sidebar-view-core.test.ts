/**
 * Unit tests for `src/tui/panes/sidebar/view-core.ts` — the framework-free
 * view logic extracted for the React sidebar port (issue #15, G3; the Solid
 * original was removed 2026-07-07). These pin the shared derivations (tab
 * cycle, budgets, empty-state key selection, the `/`-search keystroke
 * reducer, and the small row helpers).
 */

import { describe, expect, it } from "vitest"
import {
  BRANCH_LABEL_MAX,
  type SearchKeystroke,
  VIEW_TABS,
  cycleViewTarget,
  projectScrollMaxHeightFor,
  searchQueryKeystroke,
  sidebarEmptyStateKey,
  subtitleBudgetFor,
  titleBudgetFor,
  toneColor,
  truncateBranchLabel,
  truncateProjectFilterLabel,
  viewTabLabelKey,
} from "../../src/tui/panes/sidebar/view-core"

describe("view tabs", () => {
  it("cycles with wrap-around in both directions", () => {
    expect(VIEW_TABS.map((t) => t.view)).toEqual(["active", "archived"])
    expect(cycleViewTarget("active", 1)).toBe("archived")
    expect(cycleViewTarget("archived", 1)).toBe("active")
    expect(cycleViewTarget("active", -1)).toBe("archived")
    expect(cycleViewTarget("archived", -1)).toBe("active")
  })

  it("maps every view to an i18n label key", () => {
    expect(viewTabLabelKey("active")).toBe("tasks.view.workspace")
    expect(viewTabLabelKey("archived")).toBe("tasks.view.archives")
  })
})

describe("line budgets", () => {
  it("reserves 9 cells for the title line and 16 for the subtitle, floored at 6", () => {
    expect(titleBudgetFor(32)).toBe(23)
    expect(subtitleBudgetFor(32)).toBe(16)
    // A collapsed pane never produces a <=0 budget.
    expect(titleBudgetFor(4)).toBe(6)
    expect(subtitleBudgetFor(10)).toBe(6)
  })

  it("caps the PROJECTS scroll region and shrinks it to real content", () => {
    // Tall terminal, many projects: hits the 10-cell rail cap.
    expect(projectScrollMaxHeightFor(60, 12)).toBe(10)
    // One project (2-line card): reserves only its own height.
    expect(projectScrollMaxHeightFor(60, 1)).toBe(2)
    // Short terminal: the 25%-of-cells cap wins over content.
    expect(projectScrollMaxHeightFor(16, 5)).toBe(4)
    // Degenerate terminal still yields the 2-cell floor.
    expect(projectScrollMaxHeightFor(3, 5)).toBe(2)
  })

  it("fits the active project filter beside the PROJECTS header", () => {
    expect(truncateProjectFilterLabel({ label: "kobe", sectionLabel: "PROJECTS", width: 30 })).toBe("kobe")
    expect(truncateProjectFilterLabel({ label: "shushu-internship-resume", sectionLabel: "PROJECTS", width: 30 })).toBe(
      "shushu-internshi…",
    )
    expect(truncateProjectFilterLabel({ label: "长项目名称", sectionLabel: "PROJECTS", width: 17 })).toBe("长…")
    // Exact boundary: four label cells fit at width 17; one fewer cell
    // reserves the ellipsis instead of painting a fifth cell.
    expect(truncateProjectFilterLabel({ label: "kobe", sectionLabel: "PROJECTS", width: 17 })).toBe("kobe")
    expect(truncateProjectFilterLabel({ label: "kobe", sectionLabel: "PROJECTS", width: 16 })).toBe("ko…")
    expect(truncateProjectFilterLabel({ label: "all", sectionLabel: "PROJECTS", width: 16 })).toBe("all")
    // At this degenerate width even one suffix cell would overflow; containment
    // takes precedence. Production's sidebar inner width is 30 cells.
    expect(truncateProjectFilterLabel({ label: "anything", sectionLabel: "PROJECTS", width: 12 })).toBe("")
  })
})

describe("i18n key selection", () => {
  it("picks the empty-state key by search > project filter > view", () => {
    expect(sidebarEmptyStateKey({ searching: true, projectFilter: true, view: "active" })).toBe(
      "tasks.empty.noMatchSearch",
    )
    expect(sidebarEmptyStateKey({ searching: false, projectFilter: true, view: "active" })).toBe(
      "tasks.empty.noActiveProject",
    )
    expect(sidebarEmptyStateKey({ searching: false, projectFilter: true, view: "archived" })).toBe(
      "tasks.empty.noArchivedProject",
    )
    expect(sidebarEmptyStateKey({ searching: false, projectFilter: false, view: "active" })).toBe(
      "tasks.empty.noActive",
    )
    expect(sidebarEmptyStateKey({ searching: false, projectFilter: false, view: "archived" })).toBe(
      "tasks.empty.noArchived",
    )
  })
})

describe("searchQueryKeystroke", () => {
  const key = (over: Partial<SearchKeystroke>): SearchKeystroke => ({ defaultPrevented: false, ...over })

  it("appends printable single chars and pops on backspace", () => {
    expect(searchQueryKeystroke("ko", key({ sequence: "b" }))).toBe("kob")
    expect(searchQueryKeystroke("kob", key({ name: "backspace" }))).toBe("ko")
    expect(searchQueryKeystroke("", key({ name: "backspace" }))).toBe("")
  })

  it("ignores consumed, modifier-prefixed, and non-printable keys", () => {
    expect(searchQueryKeystroke("k", key({ sequence: "j", defaultPrevented: true }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ sequence: "p", ctrl: true }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ sequence: "p", meta: true }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ sequence: "p", option: true }))).toBeNull()
    // esc / arrows: multi-byte sequences or empty
    expect(searchQueryKeystroke("k", key({ name: "escape", sequence: "" }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ name: "up", sequence: "[A" }))).toBeNull()
    // control chars and DEL are not printable
    expect(searchQueryKeystroke("k", key({ sequence: "" }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ sequence: "" }))).toBeNull()
    expect(searchQueryKeystroke("k", key({ sequence: undefined }))).toBeNull()
  })
})

describe("row helpers", () => {
  it("truncateBranchLabel caps at BRANCH_LABEL_MAX by default", () => {
    const long = "feature/very-long-branch-name"
    expect(truncateBranchLabel(long).length).toBeLessThanOrEqual(BRANCH_LABEL_MAX)
    expect(truncateBranchLabel("main")).toBe("main")
  })

  it("toneColor maps every tone to its theme slot with textMuted as default", () => {
    const theme = {
      success: "S",
      warning: "W",
      primary: "P",
      error: "E",
      textMuted: "M",
    } as const
    expect(toneColor(theme, "success")).toBe("S")
    expect(toneColor(theme, "warning")).toBe("W")
    expect(toneColor(theme, "primary")).toBe("P")
    expect(toneColor(theme, "error")).toBe("E")
    expect(toneColor(theme, "textMuted")).toBe("M")
  })
})
