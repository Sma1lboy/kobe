import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { WorktreeChangesPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { WorktreeChangesCollector, trackedWorktreePaths } from "@sma1lboy/kobe-daemon/daemon/worktree-changes-collector"
import { describe, expect, test } from "vitest"
import type { WorktreeChanges } from "../../src/tui/panes/sidebar/worktree-changes.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function task(over: Omit<Partial<Task>, "id"> & { id: string }): Task {
  const { id, ...rest } = over
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repo",
    branch: id,
    worktreePath: `/wt/${id}`,
    status: "backlog",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  } as Task
}

const FAST = { timeoutMs: 1_000, slowRetryMs: 1_000, minIntervalMs: 0 }

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function harness(initialTasks: Task[], counts: Record<string, WorktreeChanges>) {
  let tasks = initialTasks
  const bus = new DaemonEventBus()
  const published: WorktreeChangesPayload[] = []
  bus.onPublish((event) => {
    if (event.channel === "worktree.changes") published.push(event.payload as WorktreeChangesPayload)
  })
  const runs: string[] = []
  const collector = new WorktreeChangesCollector({ listTasks: () => tasks }, bus, {
    cadence: FAST,
    run: async (worktreePath) => {
      runs.push(worktreePath)
      const value = counts[worktreePath]
      if (!value) throw new Error("git status failed")
      return value
    },
  })
  const setTasks = (next: Task[]): void => {
    tasks = next
  }
  return { collector, published, runs, counts, setTasks }
}

describe("trackedWorktreePaths", () => {
  test("excludes archived tasks, remote projects, and empty worktrees; dedupes shared paths", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "arch", archived: true }),
      task({ id: "remote", repo: "ssh://dev@build-box", worktreePath: "/remote/wt/remote" }),
      task({ id: "backlog", worktreePath: "" }),
      task({ id: "main1", kind: "main", repo: "/repo", worktreePath: "/repo" }),
      task({ id: "main2", kind: "main", repo: "/repo", worktreePath: "/repo" }),
    ]
    expect([...trackedWorktreePaths(tasks)].sort()).toEqual(["/repo", "/wt/a"])
  })
})

describe("WorktreeChangesCollector", () => {
  test("collects local non-archived worktrees and publishes the full map", async () => {
    const { collector, published, runs } = harness([task({ id: "a" }), task({ id: "arch", archived: true })], {
      "/wt/a": { added: 2, deleted: 1 },
    })
    collector.tick()
    await settle()
    expect(runs).toEqual(["/wt/a"])
    expect(published.at(-1)).toEqual({ changes: { "/wt/a": { added: 2, deleted: 1 } } })
  })

  test("publishes only when counts actually changed", async () => {
    const { collector, published, counts } = harness([task({ id: "a" })], { "/wt/a": { added: 1, deleted: 0 } })
    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    counts["/wt/a"] = { added: 3, deleted: 0 }
    collector.tick()
    await settle()
    expect(published.length).toBe(2)
    expect(published.at(-1)).toEqual({ changes: { "/wt/a": { added: 3, deleted: 0 } } })
  })

  test("a failing run keeps the last published value (never errors, never publishes garbage)", async () => {
    const { collector, published, counts } = harness([task({ id: "a" })], { "/wt/a": { added: 1, deleted: 0 } })
    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    counts["/wt/a"] = undefined as unknown as WorktreeChanges
    collector.tick()
    await settle()
    expect(published.length).toBe(1)
  })

  test("drops a deleted/archived task's entry from the published map", async () => {
    const { collector, published, setTasks } = harness([task({ id: "a" }), task({ id: "b" })], {
      "/wt/a": { added: 1, deleted: 0 },
      "/wt/b": { added: 2, deleted: 2 },
    })
    collector.tick()
    await settle()
    expect(Object.keys(published.at(-1)?.changes ?? {}).sort()).toEqual(["/wt/a", "/wt/b"])

    setTasks([task({ id: "a" }), task({ id: "b", archived: true })])
    collector.tick()
    await settle()
    expect(published.at(-1)).toEqual({ changes: { "/wt/a": { added: 1, deleted: 0 } } })
  })

  test("dedupes in-flight runs — a tick landing mid-status starts nothing", async () => {
    let release: ((v: WorktreeChanges) => void) | undefined
    const bus = new DaemonEventBus()
    const runs: string[] = []
    const collector = new WorktreeChangesCollector({ listTasks: () => [task({ id: "a" })] }, bus, {
      cadence: FAST,
      run: (worktreePath) => {
        runs.push(worktreePath)
        return new Promise((r) => {
          release = r
        })
      },
    })
    collector.tick()
    collector.tick()
    collector.tick()
    expect(runs).toEqual(["/wt/a"])
    release?.({ added: 0, deleted: 0 })
    await settle()
  })

  test("a run completing after its task was pruned does not resurrect the entry", async () => {
    let release: ((v: WorktreeChanges) => void) | undefined
    const tasks = { current: [task({ id: "a" })] }
    const bus = new DaemonEventBus()
    const published: WorktreeChangesPayload[] = []
    bus.onPublish((event) => {
      if (event.channel === "worktree.changes") published.push(event.payload as WorktreeChangesPayload)
    })
    const collector = new WorktreeChangesCollector({ listTasks: () => tasks.current }, bus, {
      cadence: FAST,
      run: () =>
        new Promise((r) => {
          release = r
        }),
    })
    collector.tick()
    tasks.current = []
    collector.tick()
    release?.({ added: 5, deleted: 5 })
    await settle()
    expect(published).toEqual([])
  })

  test("pauses entirely while hasSubscribers is false, resumes when true", async () => {
    let subscribed = false
    const bus = new DaemonEventBus()
    const published: WorktreeChangesPayload[] = []
    bus.onPublish((event) => {
      if (event.channel === "worktree.changes") published.push(event.payload as WorktreeChangesPayload)
    })
    const runs: string[] = []
    const collector = new WorktreeChangesCollector({ listTasks: () => [task({ id: "a" })] }, bus, {
      cadence: FAST,
      hasSubscribers: () => subscribed,
      run: async (worktreePath) => {
        runs.push(worktreePath)
        return { added: 1, deleted: 0 }
      },
    })

    collector.tick()
    await settle()
    expect(runs).toEqual([])
    expect(published).toEqual([])

    subscribed = true
    collector.tick()
    await settle()
    expect(runs).toEqual(["/wt/a"])
    expect(published.at(-1)).toEqual({ changes: { "/wt/a": { added: 1, deleted: 0 } } })
  })

  test("collects unconditionally when hasSubscribers is omitted (back-compat)", async () => {
    const { collector, runs } = harness([task({ id: "a" })], { "/wt/a": { added: 2, deleted: 1 } })
    collector.tick()
    await settle()
    expect(runs).toEqual(["/wt/a"])
  })

  test("tick never throws when the task lister blows up", () => {
    const bus = new DaemonEventBus()
    const collector = new WorktreeChangesCollector(
      {
        listTasks: () => {
          throw new Error("store exploded")
        },
      },
      bus,
      { cadence: FAST, run: async () => ({ added: 0, deleted: 0 }) },
    )
    expect(() => collector.tick()).not.toThrow()
  })
})
