import { describe, expect, it } from "vitest"
import {
  TAB_KINDS,
  tabHasPty,
  nextTabTitle,
  type WorkspaceTabKind,
} from "../src/lib/tab-kinds.ts"

/**
 * tab-kinds is the single source of truth for the two cross-cutting facts a
 * tab's kind drives: whether it owns a PTY (so close/prune tears it down) and
 * how a fresh tab of the kind is titled. These tests pin both so a new kind
 * can't silently miss a PTY-cleanup guard or a title rule.
 */

const ALL: WorkspaceTabKind[] = [
  "empty",
  "vendor",
  "terminal",
  "transcript",
  "file",
]

describe("tabHasPty — which kinds own a server-side PTY", () => {
  it("only vendor and terminal have PTYs", () => {
    expect(tabHasPty("vendor")).toBe(true)
    expect(tabHasPty("terminal")).toBe(true)
    expect(tabHasPty("empty")).toBe(false)
    expect(tabHasPty("transcript")).toBe(false)
    expect(tabHasPty("file")).toBe(false)
  })

  it("every kind declares a hasPty (registry is complete)", () => {
    for (const kind of ALL) {
      expect(typeof TAB_KINDS[kind].hasPty).toBe("boolean")
    }
  })
})

describe("nextTabTitle — fresh-tab titling", () => {
  it("static kinds use their fixed label", () => {
    expect(nextTabTitle("empty", [])).toBe("New tab")
    expect(nextTabTitle("transcript", [])).toBe("Chat")
  })

  it("count kinds number off the existing tabs of that kind", () => {
    expect(nextTabTitle("vendor", [])).toBe("Vendor 1")
    expect(
      nextTabTitle("vendor", [
        { kind: "vendor" },
        { kind: "terminal" },
        { kind: "vendor" },
      ]),
    ).toBe("Vendor 3")
    expect(nextTabTitle("terminal", [{ kind: "terminal" }])).toBe("Terminal 2")
  })

  it("the count ignores other kinds", () => {
    // Two transcripts + an empty don't bump the vendor count.
    expect(
      nextTabTitle("vendor", [
        { kind: "transcript" },
        { kind: "empty" },
        { kind: "transcript" },
      ]),
    ).toBe("Vendor 1")
  })

  it("derived kinds (file) fall back to their bare label — the caller titles them", () => {
    expect(nextTabTitle("file", [])).toBe("File")
  })
})
