/**
 * Unit tests for the pure formatting helpers in `src/cli/diagnose.ts`.
 *
 * Why these tests matter:
 *   - `kobe diagnose` is what the user pastes into a bug report. If the
 *     formatting helpers regress (mis-counted statuses, wrong byte
 *     unit, drift in the missing/dangling reconciliation), the report
 *     gets harder to read at exactly the moment the user is least
 *     patient. Cheap unit tests for the deterministic core are the
 *     right tradeoff.
 *   - We deliberately don't try to exercise the IO probes
 *     (binary/version/dir-size). Those depend on the host machine and
 *     would either flake or just re-test Node's stdlib. The wrapping
 *     try/catch contract is the IO promise; it's easier to read in the
 *     code than it is to mock out.
 */

import { describe, expect, it } from "vitest"
import {
  formatBytes,
  formatKv,
  formatTaskBreakdown,
  reconcileWorktrees,
} from "../../src/cli/diagnose.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

function task(over: Partial<Task> = {}): Task {
  // Minimal task fixture. Fields not under test default to inert values.
  // Cast through `as Task` only so we can omit the deprecated readonly
  // alias plumbing that the production paths normalize for us.
  const t: Task = {
    id: toTaskId("01J0000000000000000000000T"),
    title: "t",
    repo: "/repo",
    branch: "main",
    worktreePath: "/repo/.claude/worktrees/01J0000000000000000000000T",
    sessionId: null,
    tabs: [{ id: "tab-1", sessionId: null, createdAt: "2026-05-09T00:00:00.000Z" }],
    activeTabId: "tab-1",
    status: "backlog",
    archived: false,
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    ...over,
  }
  return t
}

describe("formatKv", () => {
  it("pads short keys to a uniform column", () => {
    const a = formatKv("path:", "/usr/local/bin/claude")
    const b = formatKv("version:", "1.2.3")
    // The values should start at the same column.
    const aValueIdx = a.indexOf("/usr")
    const bValueIdx = b.indexOf("1.2.3")
    expect(aValueIdx).toBe(bValueIdx)
  })

  it("does not truncate long keys (better to break alignment than lie)", () => {
    const out = formatKv("extremely-long-key:", "v")
    expect(out.startsWith("extremely-long-key:")).toBe(true)
    expect(out.endsWith("v")).toBe(true)
  })
})

describe("formatTaskBreakdown", () => {
  it("reports a total even with no tasks", () => {
    expect(formatTaskBreakdown([])).toBe("total=0 backlog=0 in_progress=0 done=0")
  })

  it("counts each status independently", () => {
    const tasks = [
      task({ status: "backlog" }),
      task({ status: "backlog" }),
      task({ status: "in_progress" }),
      task({ status: "done" }),
      task({ status: "done" }),
      task({ status: "done" }),
      task({ status: "error" }),
    ]
    const out = formatTaskBreakdown(tasks)
    expect(out).toContain("total=7")
    expect(out).toContain("backlog=2")
    expect(out).toContain("in_progress=1")
    expect(out).toContain("done=3")
    expect(out).toContain("error=1")
  })

  it("suppresses zero counts only for the rare terminal states", () => {
    const tasks = [task({ status: "backlog" })]
    const out = formatTaskBreakdown(tasks)
    // backlog/in_progress/done always shown — even when zero.
    expect(out).toContain("backlog=1")
    expect(out).toContain("in_progress=0")
    expect(out).toContain("done=0")
    // Rare ones omitted when zero.
    expect(out).not.toContain("in_review=")
    expect(out).not.toContain("canceled=")
    expect(out).not.toContain("error=")
  })

  it("includes rare states when they are non-zero", () => {
    const tasks = [task({ status: "in_review" }), task({ status: "canceled" })]
    const out = formatTaskBreakdown(tasks)
    expect(out).toContain("in_review=1")
    expect(out).toContain("canceled=1")
  })
})

describe("formatBytes", () => {
  it("prints raw bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("rolls up to KB / MB / GB / TB with one decimal", () => {
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB")
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB")
  })

  it("guards against junk inputs", () => {
    expect(formatBytes(-1)).toBe("(unknown)")
    expect(formatBytes(Number.NaN)).toBe("(unknown)")
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("(unknown)")
  })
})

describe("reconcileWorktrees", () => {
  it("flags tasks whose worktree dir is missing on disk", () => {
    const tasks = [
      task({
        id: toTaskId("01AAAA"),
        repo: "/r",
        worktreePath: "/r/.claude/worktrees/01AAAA",
      }),
      task({
        id: toTaskId("01BBBB"),
        repo: "/r",
        worktreePath: "/r/.claude/worktrees/01BBBB",
      }),
    ]
    const onDisk = new Map<string, readonly string[]>([["/r", ["01AAAA"]]])
    const out = reconcileWorktrees(tasks, onDisk)
    expect(out.taskCount).toBe(2)
    expect(out.onDiskCount).toBe(1)
    expect(out.missing).toEqual(["/r/.claude/worktrees/01BBBB"])
    expect(out.dangling).toEqual([])
  })

  it("flags on-disk dirs that no task references", () => {
    const tasks = [
      task({
        id: toTaskId("01AAAA"),
        repo: "/r",
        worktreePath: "/r/.claude/worktrees/01AAAA",
      }),
    ]
    const onDisk = new Map<string, readonly string[]>([["/r", ["01AAAA", "01ORPHAN"]]])
    const out = reconcileWorktrees(tasks, onDisk)
    expect(out.missing).toEqual([])
    expect(out.dangling).toEqual(["/r/.claude/worktrees/01ORPHAN"])
  })

  it("handles multiple repos independently", () => {
    const tasks = [
      task({ id: toTaskId("01A"), repo: "/r1", worktreePath: "/r1/.claude/worktrees/01A" }),
      task({ id: toTaskId("01B"), repo: "/r2", worktreePath: "/r2/.claude/worktrees/01B" }),
    ]
    const onDisk = new Map<string, readonly string[]>([
      ["/r1", ["01A"]],
      ["/r2", []],
    ])
    const out = reconcileWorktrees(tasks, onDisk)
    expect(out.missing).toEqual(["/r2/.claude/worktrees/01B"])
    expect(out.dangling).toEqual([])
  })

  it("returns clean shape for empty input", () => {
    const out = reconcileWorktrees([], new Map())
    expect(out).toEqual({ taskCount: 0, onDiskCount: 0, missing: [], dangling: [] })
  })
})
