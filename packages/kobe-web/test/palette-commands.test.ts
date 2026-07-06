import { describe, expect, it } from "vitest"
import {
  orderTasksForPalette,
  themeCommandEntries,
} from "../src/lib/palette-commands.ts"
import type { Task } from "../src/lib/types.ts"


describe("themeCommandEntries", () => {
  it("returns one entry per theme with a stable id and a 'Theme: ' label", () => {
    const out = themeCommandEntries(["claude", "tokyonight"], null)
    expect(out).toEqual([
      { id: "theme:claude", label: "Theme: claude", hint: "theme", name: "claude" },
      {
        id: "theme:tokyonight",
        label: "Theme: tokyonight",
        hint: "theme",
        name: "tokyonight",
      },
    ])
  })

  it("flags the active theme with the 'active' hint", () => {
    const out = themeCommandEntries(["claude", "tokyonight"], "tokyonight")
    expect(out.find((e) => e.name === "tokyonight")?.hint).toBe("active")
    expect(out.find((e) => e.name === "claude")?.hint).toBe("theme")
  })

  it("returns an empty list before themes have loaded", () => {
    expect(themeCommandEntries([], null)).toEqual([])
  })

  it("carries the name through for setPreferredTheme to apply", () => {
    expect(themeCommandEntries(["claude"], null)[0].name).toBe("claude")
  })
})

describe("orderTasksForPalette", () => {
  const task = (id: string, over: Partial<Task> = {}): Task =>
    ({
      id,
      title: id,
      repo: "/r",
      branch: id,
      worktreePath: `/w/${id}`,
      kind: "task",
      status: "backlog",
      archived: false,
      pinned: false,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      ...over,
    }) as Task

  it("orders most-recently-updated first", () => {
    const out = orderTasksForPalette([
      task("old", { updatedAt: "2026-06-01T00:00:00Z" }),
      task("new", { updatedAt: "2026-06-10T00:00:00Z" }),
      task("mid", { updatedAt: "2026-06-05T00:00:00Z" }),
    ])
    expect(out.map((t) => t.id)).toEqual(["new", "mid", "old"])
  })

  it("drops archived tasks", () => {
    const out = orderTasksForPalette([
      task("a"),
      task("gone", { archived: true }),
    ])
    expect(out.map((t) => t.id)).toEqual(["a"])
  })

  it("breaks ties by id (stable order for equal timestamps)", () => {
    const out = orderTasksForPalette([
      task("a", { updatedAt: "2026-06-01T00:00:00Z" }),
      task("b", { updatedAt: "2026-06-01T00:00:00Z" }),
    ])
    expect(out.map((t) => t.id)).toEqual(["b", "a"])
  })

  it("falls back to createdAt when updatedAt is missing", () => {
    const out = orderTasksForPalette([
      task("old", { updatedAt: "", createdAt: "2026-06-01T00:00:00Z" }),
      task("new", { updatedAt: "", createdAt: "2026-06-09T00:00:00Z" }),
    ])
    expect(out.map((t) => t.id)).toEqual(["new", "old"])
  })
})
