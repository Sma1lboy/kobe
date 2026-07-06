import { describe, expect, it } from "vitest"
import { rowClass, statusBadge } from "../src/lib/diff-display.ts"


describe("statusBadge", () => {
  it("maps each known status to its letter + color", () => {
    expect(statusBadge("added")).toEqual({ label: "A", cls: "text-kobe-green" })
    expect(statusBadge("untracked")).toEqual({
      label: "U",
      cls: "text-kobe-green",
    })
    expect(statusBadge("modified")).toEqual({
      label: "M",
      cls: "text-kobe-yellow",
    })
    expect(statusBadge("deleted")).toEqual({ label: "D", cls: "text-kobe-red" })
    expect(statusBadge("renamed")).toEqual({ label: "R", cls: "text-kobe-blue" })
    expect(statusBadge("copied")).toEqual({ label: "C", cls: "text-kobe-blue" })
  })

  it("falls back to the uppercased first letter for an unknown status", () => {
    expect(statusBadge("type changed")).toEqual({
      label: "T",
      cls: "text-muted",
    })
  })

  it("shows '?' (never blank) for an empty status", () => {
    expect(statusBadge("")).toEqual({ label: "?", cls: "text-muted" })
  })
})

describe("rowClass", () => {
  it("maps each diff row kind to its CSS class", () => {
    expect(rowClass("hunk")).toBe("kobe-diff-hunk")
    expect(rowClass("meta")).toBe("kobe-diff-meta")
    expect(rowClass("add")).toBe("kobe-diff-add")
    expect(rowClass("del")).toBe("kobe-diff-del")
    expect(rowClass("ctx")).toBe("kobe-diff-ctx")
  })
})
