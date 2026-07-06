/**
 * Unit tests for the React new-task dialog's extracted pure helpers
 * (`src/tui-react/component/new-task-dialog/pure.ts`). These were inline
 * in the Solid shell; the React port pulls them out so the vendor-set
 * fallback, initial-vendor clamping, and adopt multi-select semantics
 * are pinned without mounting the dialog (no @opentui import here —
 * vitest never loads the renderer).
 *
 * Why these matter: the vendor fallback is what guarantees the engine
 * selector is never empty (task creation must never be blocked by a
 * missing detection result), and the ctrl+a toggle semantics decide
 * whether an Adopt import silently targets the wrong worktree set.
 */

import { describe, expect, it } from "vitest"
import {
  resolveInitialVendor,
  resolveVendorSet,
  toggleInSet,
  toggleSelectAll,
} from "../../src/tui-react/component/new-task-dialog/pure"
import { ALL_VENDORS } from "../../src/types/vendor"

describe("resolveVendorSet", () => {
  it("falls back to ALL_VENDORS when undefined or empty", () => {
    expect(resolveVendorSet(undefined)).toEqual(ALL_VENDORS)
    expect(resolveVendorSet([])).toEqual(ALL_VENDORS)
  })
  it("returns the detected set verbatim when non-empty", () => {
    expect(resolveVendorSet(["codex"])).toEqual(["codex"])
  })
})

describe("resolveInitialVendor", () => {
  it("keeps the preferred vendor when it is detected", () => {
    expect(resolveInitialVendor(["claude", "codex"], "codex")).toBe("codex")
  })
  it("clamps to the first detected vendor when the preference is missing", () => {
    expect(resolveInitialVendor(["codex"], "claude")).toBe("codex")
  })
  it("defaults to claude with no preference", () => {
    expect(resolveInitialVendor(["claude", "codex"], undefined)).toBe("claude")
  })
  it("falls back to claude on an empty set (never crashes)", () => {
    expect(resolveInitialVendor([], undefined)).toBe("claude")
  })
})

describe("toggleInSet", () => {
  it("adds a missing path and removes a present one, immutably", () => {
    const start: ReadonlySet<string> = new Set(["/a"])
    const added = toggleInSet(start, "/b")
    expect([...added].sort()).toEqual(["/a", "/b"])
    const removed = toggleInSet(added, "/a")
    expect([...removed]).toEqual(["/b"])
    expect([...start]).toEqual(["/a"]) // original untouched
  })
})

describe("toggleSelectAll", () => {
  const paths = ["/a", "/b", "/c"]
  it("selects everything when the selection is partial", () => {
    expect([...toggleSelectAll(new Set(["/a"]), paths)].sort()).toEqual(paths)
  })
  it("clears when everything is already selected", () => {
    expect(toggleSelectAll(new Set(paths), paths).size).toBe(0)
  })
  it("is a no-op on an empty list", () => {
    const prev: ReadonlySet<string> = new Set(["/x"])
    expect(toggleSelectAll(prev, [])).toBe(prev)
  })
})
