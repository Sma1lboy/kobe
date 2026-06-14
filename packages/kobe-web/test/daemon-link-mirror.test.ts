import { describe, expect, it } from "vitest"
import { DaemonLink } from "../server/daemon-link.ts"

/**
 * The bridge keeps a local mirror of daemon channel state so a late browser
 * hydrates in one SSE `snapshot` frame. `onFrame` is the reducer that keeps
 * that mirror current; it's private, so we drive it through a cast and observe
 * via the public `snapshot()`. A fresh DaemonLink is inert until `start()`
 * (no constructor socket work), so this never touches a real daemon.
 *
 * Coverage targets:
 *  - the round-2 engineStates prune on task.snapshot (the mirror grew forever
 *    before the fix — a deleted task's trailing idle frame never swept).
 *  - the task.jobs reducer (running tracks; terminal phase clears).
 *  - the SSE forward filter (only SPA channels reach sinks; daemon.stopping is
 *    a lifecycle signal and must NOT forward).
 */

// onFrame is private; this is the test-only seam to drive it.
type FrameDriver = { onFrame(name: string, payload: unknown): void }
const drive = (link: DaemonLink): FrameDriver =>
  link as unknown as FrameDriver

const snap = (taskId: string) => ({
  taskId,
  state: "running",
  at: 1,
})
const taskList = (...ids: string[]) => ({ tasks: ids.map((id) => ({ id })) })

describe("DaemonLink mirror — engineStates prune on task.snapshot", () => {
  it("drops engine-state for tasks absent from the new snapshot", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("engine-state", snap("a"))
    f.onFrame("engine-state", snap("b"))
    f.onFrame("engine-state", snap("gone"))
    expect(Object.keys(link.snapshot().engineStates).sort()).toEqual([
      "a",
      "b",
      "gone",
    ])
    f.onFrame("task.snapshot", taskList("a", "b"))
    expect(Object.keys(link.snapshot().engineStates).sort()).toEqual(["a", "b"])
  })

  it("keeps the mirror intact when every engine-state task is still live", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("engine-state", snap("a"))
    f.onFrame("task.snapshot", taskList("a", "b"))
    expect(Object.keys(link.snapshot().engineStates)).toEqual(["a"])
  })
})

describe("DaemonLink mirror — task.jobs reducer", () => {
  it("tracks a running job and clears it on a terminal phase", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("task.jobs", { taskId: "a", kind: "worktree", phase: "running" })
    expect(Object.keys(link.snapshot().jobs)).toEqual(["a"])
    f.onFrame("task.jobs", { taskId: "a", kind: "worktree", phase: "done" })
    expect(link.snapshot().jobs).toEqual({})
  })

  it("clears only the finished task's job", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("task.jobs", { taskId: "a", kind: "worktree", phase: "running" })
    f.onFrame("task.jobs", { taskId: "b", kind: "worktree", phase: "running" })
    f.onFrame("task.jobs", { taskId: "a", kind: "worktree", phase: "error" })
    expect(Object.keys(link.snapshot().jobs)).toEqual(["b"])
  })
})

describe("DaemonLink mirror — issue snapshots", () => {
  it("stores the latest issue state by repo and forwards the channel", () => {
    const link = new DaemonLink()
    const f = drive(link)
    const forwarded: string[] = []
    link.onEvent((e) => forwarded.push(e.channel))

    f.onFrame("issue.snapshot", {
      repoRoot: "/repo",
      exists: true,
      nextId: 2,
      issues: [{ id: 1, title: "fix", status: "open", created: "2026-06-13", body: "" }],
    })

    expect(link.snapshot().issueSnapshots).toEqual({
      "/repo": {
        repoRoot: "/repo",
        exists: true,
        nextId: 2,
        issues: [{ id: 1, title: "fix", status: "open", created: "2026-06-13", body: "" }],
      },
    })
    expect(forwarded).toContain("issue.snapshot")
  })

  it("aliases worktree issue pushes back to the source repo in snapshots", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("task.snapshot", {
      tasks: [
        {
          id: "t1",
          repo: "/Users/narwhal/proj/kobe/",
          worktreePath: "/Users/narwhal/.kobe/worktrees/kobe/bovid",
        },
      ],
    })
    f.onFrame("issue.snapshot", {
      repoRoot: "/Users/narwhal/.kobe/worktrees/kobe/bovid",
      exists: true,
      nextId: 2,
      issues: [{ id: 1, title: "fix", status: "done", created: "2026-06-13", body: "" }],
    })

    expect(link.snapshot().issueSnapshots["/Users/narwhal/proj/kobe/"]).toEqual(
      expect.objectContaining({
        repoRoot: "/Users/narwhal/proj/kobe/",
        issues: [expect.objectContaining({ id: 1, status: "done" })],
      }),
    )
  })

  it("keeps the conflict-radar mirror alongside issue snapshots", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("task.conflicts", { pairs: [{ a: "x", b: "y", files: ["f.ts"], level: "conflict" }] })
    f.onFrame("issue.snapshot", { repoRoot: "/repo", exists: true, nextId: 1, issues: [] })
    expect(link.snapshot().conflicts).toEqual([{ a: "x", b: "y", files: ["f.ts"], level: "conflict" }])
    expect(link.snapshot().issueSnapshots["/repo"]).toMatchObject({ repoRoot: "/repo" })
  })
})

describe("DaemonLink — SSE forward filter", () => {
  it("forwards SPA channels but never the daemon.stopping lifecycle signal", () => {
    const link = new DaemonLink()
    const f = drive(link)
    const forwarded: string[] = []
    link.onEvent((e) => forwarded.push(e.channel))

    f.onFrame("active-task", { taskId: "a" })
    f.onFrame("ui-prefs", { theme: "claude" })
    f.onFrame("daemon.stopping", {})

    expect(forwarded).toContain("active-task")
    expect(forwarded).toContain("ui-prefs")
    expect(forwarded).not.toContain("daemon.stopping")
  })

  it("mirrors active-task and ui-prefs into the snapshot", () => {
    const link = new DaemonLink()
    const f = drive(link)
    f.onFrame("active-task", { taskId: "x" })
    f.onFrame("ui-prefs", { theme: "tokyonight" })
    expect(link.snapshot().activeTaskId).toBe("x")
    expect(link.snapshot().uiPrefs).toEqual({ theme: "tokyonight" })
  })
})
