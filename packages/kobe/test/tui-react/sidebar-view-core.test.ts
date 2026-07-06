/**
 * Unit tests for `src/tui/panes/sidebar/view-core.ts` — the framework-free
 * view logic extracted for the React sidebar port (issue #15, G3) and
 * consumed by BOTH renderers. These pin the shared derivations (tab cycle,
 * budgets, empty-state key selection, the `/`-search keystroke reducer, and
 * the small row helpers) so the Solid original and the React port cannot
 * drift: a behavior change here is a behavior change in two shipped panes.
 */

import { describe, expect, it } from "vitest"
import type { ChatRunState } from "../../src/tui/panes/sidebar/types"
import {
  BRANCH_LABEL_MAX,
  type SearchKeystroke,
  VIEW_TABS,
  cycleViewTarget,
  projectScrollMaxHeightFor,
  projectTaskCountKey,
  searchQueryKeystroke,
  sidebarEmptyStateKey,
  subtitleBudgetFor,
  taskIsLive,
  titleBudgetFor,
  toneColor,
  truncateBranchLabel,
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

  it("pluralizes the project task-count label key", () => {
    expect(projectTaskCountKey(1)).toBe("tasks.project.taskSingular")
    expect(projectTaskCountKey(0)).toBe("tasks.project.taskPlural")
    expect(projectTaskCountKey(2)).toBe("tasks.project.taskPlural")
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

  it("taskIsLive matches only running states under the task's key prefix", () => {
    const map = new Map<string, ChatRunState>([
      ["a:tab1", "idle"],
      ["a:tab2", "running"],
      ["b:tab1", "running"],
    ])
    expect(taskIsLive("a", map)).toBe(true)
    expect(taskIsLive("c", map)).toBe(false)
    expect(taskIsLive("a", undefined)).toBe(false)
    // Prefix discipline: "a" must not match a task id "ab".
    const tricky = new Map<string, ChatRunState>([["ab:tab1", "running"]])
    expect(taskIsLive("a", tricky)).toBe(false)
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
