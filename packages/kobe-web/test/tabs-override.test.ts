import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/terminal.ts", () => ({ closePtyTab: vi.fn() }))

import { addTab, ensureEngineTab, pruneMissingTasks } from "../src/lib/tabs.ts"
import { closePtyTab } from "../src/lib/terminal.ts"

/**
 * Vendor-tab engine override: a tab whose PTY is pinned to ANOTHER task
 * (a worktree session surfaced in the project workspace). Contract under
 * test: ensureEngineTab must never hand out an override tab as the bucket
 * task's own session, and pruneMissingTasks must reap override tabs whose
 * engine task died (their PTY runs in a deleted worktree) while leaving the
 * live bucket alone. Unique task ids per case — the store is module state.
 */

beforeEach(() => {
  vi.mocked(closePtyTab).mockReset()
})

describe("vendor-tab engine override", () => {
  it("ensureEngineTab skips override tabs and mints the bucket's own", () => {
    const overrideTab = addTab("proj-A", "wt-A")
    const own = ensureEngineTab("proj-A")
    expect(own).not.toBe(overrideTab)
    // Idempotent on the bucket's own tab, still skipping the override.
    expect(ensureEngineTab("proj-A")).toBe(own)
  })

  it("addTab with the bucket's own id stores no override", () => {
    const plain = addTab("proj-B", "proj-B")
    expect(ensureEngineTab("proj-B")).toBe(plain)
  })

  it("prune reaps override tabs whose engine task died, keeps the bucket", () => {
    const deadOverride = addTab("proj-C", "wt-dead")
    const liveOverride = addTab("proj-C", "wt-live")
    const own = addTab("proj-C")
    pruneMissingTasks(new Set(["proj-C", "wt-live"]))
    // Only the dead-engine tab's PTY is closed; its tab is gone from the
    // bucket while the live override and the bucket's own tab survive.
    expect(closePtyTab).toHaveBeenCalledWith(deadOverride)
    expect(closePtyTab).not.toHaveBeenCalledWith(liveOverride)
    expect(closePtyTab).not.toHaveBeenCalledWith(own)
    expect(ensureEngineTab("proj-C")).toBe(own)
  })
})
