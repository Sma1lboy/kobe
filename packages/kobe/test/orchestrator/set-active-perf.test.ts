/**
 * Perf-budget regression net for the focus-switch hot path — OPERATION
 * COUNTS, never wall-clock (docs/HARNESS.md §Performance contracts).
 *
 * `setActiveTask` is the single most frequent user action in this multi-
 * session TUI (every task/focus switch). It used to call
 * `store.update(id, {})` with an EMPTY patch purely to bump `updatedAt` so
 * the sidebar's `recent` sort tracks focus order. That empty patch still
 * ran a full fsync'd read-merge-write (`doSave`: flock + read + merge +
 * `handle.sync()` + rename) on EVERY switch — one fsync'd disk rewrite +
 * one full-list broadcast, all to move a field the DEFAULT sort never reads.
 *
 * The fix (`store.touchRecency`) bumps `updatedAt` in-cache + notifies
 * listeners (so `recent` still reorders LIVE) but flushes lazily on the next
 * real mutation — zero fsync on the focus path. This pins that budget:
 *
 *   - fsync'd disk rewrites over 10 setActive calls: 0 (was 10).
 *   - listeners STILL notified per switch (live `recent` reorders) → 10.
 *   - a later REAL mutation flushes the lazily-accumulated recency once → 1.
 *
 * `active-task` frames publishing per switch is a property of the daemon
 * handler (unchanged by this fix); it's pinned separately in
 * `test/daemon/set-active-frame.test.ts`.
 *
 * The disk-write count is observed at the SAME seam production writes: the
 * atomic `rename(tmpPath, tasks.json)` that completes a `doSave`. A regression
 * that puts a synchronous persist back on the focus path shows up as extra
 * renames to the manifest, which the UI would never reveal — exactly why a
 * counting test, not eyeballing, holds this line.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

/**
 * The store completes a doSave with `rename(tmpPath, tasks.json)`. Wrap the
 * real `node:fs/promises` so `rename` records every call while behaving
 * normally — the SAME seam the store writes through, so the recorded count IS
 * the fsync'd-disk-rewrite count. (A plain `vi.spyOn` can't redefine the ESM
 * named binding the store already captured; a module mock intercepts it.)
 */
const renameCalls = vi.hoisted(() => ({ dests: [] as string[] }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCalls.dests.push(String(to))
      return actual.rename(from, to)
    },
  }
})

describe("setActiveTask focus-switch op budget", () => {
  let home: string
  let orch: Orchestrator
  let store: TaskIndexStore

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-set-active-perf-"))
    vi.stubEnv("KOBE_HOME_DIR", home)
    store = new TaskIndexStore({ homeDir: home })
    await store.load()
    orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
    renameCalls.dests.length = 0
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    orch.dispose()
    await rm(home, { recursive: true, force: true })
  })

  /** Renames whose destination is the store's manifest = a completed doSave. */
  function diskWritesToManifest(): number {
    return renameCalls.dests.filter((dest) => dest === store.filePath).length
  }

  it("does ZERO fsync'd disk rewrites across 10 focus switches, still notifies every switch, and flushes lazily on the next real write", async () => {
    // N=5 tasks + a subscribed listener, mirroring a live daemon with an
    // attached Tasks pane driving the `task.snapshot` broadcast.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const t = await orch.createTask({ repo: "/repo", title: `t${i}`, branch: `t${i}`, vendor: "claude" })
      ids.push(String(t.id))
    }
    let snapshotPublishes = 0
    const unsub = orch.subscribeTasks(() => {
      snapshotPublishes++
    })

    // Isolate the focus-switch path from the 5 creates + the subscribe echo.
    renameCalls.dests.length = 0
    snapshotPublishes = 0

    // 10 focus switches, cycling the 5 tasks (consecutive ids always differ).
    for (let i = 0; i < 10; i++) {
      await orch.setActiveTask(ids[i % 5] ?? null)
    }

    // THE win: the focus path no longer fsyncs a disk rewrite per switch.
    expect(diskWritesToManifest()).toBe(0)
    // Listeners STILL notified per switch so live `recent` reorders — the
    // broadcast is not the cost we removed (the fsync'd disk rewrite is).
    expect(snapshotPublishes).toBe(10)

    // Lazy flush: the accumulated recency bumps ride the NEXT real mutation's
    // save — exactly ONE fsync'd disk rewrite, not the 10 we removed.
    renameCalls.dests.length = 0
    await orch.setTitle(ids[0] ?? "", "renamed")
    expect(diskWritesToManifest()).toBe(1)

    unsub()
  })
})
