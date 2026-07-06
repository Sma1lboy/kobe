import { describe, expect, it } from "vitest"
import type { EngineOption } from "../src/lib/engines.ts"
import type { Task } from "../src/lib/types.ts"
import {
  DEFAULT_VENDOR,
  distinctTaskVendors,
  isMixedEngineWorkspace,
  perRowEngineLabel,
  resolveVendor,
} from "../src/lib/vendor.ts"

/**
 * Vendor-identity rules: the unset-vendor default, the mixed-workspace
 * aggregations, and the per-row label rule — all in one place so a vendor
 * default change touches one line and the rules are testable without rendering
 * a row. (engineLabel itself is covered by engine-label.test.ts.)
 */

const task = (over: Partial<Task>): Task =>
  ({ id: over.id ?? "t", kind: "task", pinned: false, title: "", ...over }) as Task

const LIST: EngineOption[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
]

describe("resolveVendor", () => {
  it("passes a set vendor through and defaults an unset one", () => {
    expect(resolveVendor("codex")).toBe("codex")
    expect(resolveVendor(undefined)).toBe(DEFAULT_VENDOR)
    expect(resolveVendor("")).toBe(DEFAULT_VENDOR)
  })
})

describe("isMixedEngineWorkspace / distinctTaskVendors", () => {
  it("is false when every worktree task runs the same engine", () => {
    const t = [task({ id: "a", vendor: "claude" }), task({ id: "b", vendor: "claude" })]
    expect(isMixedEngineWorkspace(t)).toBe(false)
    expect(distinctTaskVendors(t)).toEqual(["claude"])
  })

  it("is true when worktree tasks run different engines", () => {
    const t = [task({ id: "a", vendor: "claude" }), task({ id: "b", vendor: "codex" })]
    expect(isMixedEngineWorkspace(t)).toBe(true)
    expect(distinctTaskVendors(t).sort()).toEqual(["claude", "codex"])
  })

  it("treats an unset vendor as the default", () => {
    const t = [task({ id: "a", vendor: undefined }), task({ id: "b", vendor: "codex" })]
    expect(isMixedEngineWorkspace(t)).toBe(true)
    expect(distinctTaskVendors([task({ id: "a", vendor: undefined })])).toEqual([DEFAULT_VENDOR])
  })

  it("ignores project (main) and archived rows", () => {
    const t = [
      task({ id: "a", vendor: "claude" }),
      task({ id: "m", kind: "main", vendor: "codex" }),
      task({ id: "z", archived: true, vendor: "codex" }),
    ]
    expect(isMixedEngineWorkspace(t)).toBe(false)
  })
})

describe("perRowEngineLabel", () => {
  it("returns a label only in a mixed workspace", () => {
    expect(perRowEngineLabel(LIST, task({ id: "a", vendor: "codex" }), true)).toBe("Codex")
    expect(perRowEngineLabel(LIST, task({ id: "a", vendor: "codex" }), false)).toBeNull()
  })

  it("never labels a project (main) row", () => {
    expect(perRowEngineLabel(LIST, task({ id: "m", kind: "main", vendor: "codex" }), true)).toBeNull()
  })
})
