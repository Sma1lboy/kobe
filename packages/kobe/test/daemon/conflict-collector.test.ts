import {
  type CardFootprint,
  ConflictCollector,
  GitGate,
  overlapPairs,
  parseMergeTreeNames,
  parsePorcelainPaths,
  sameFootprint,
  trackedConflictTasks,
} from "@sma1lboy/kobe-daemon/daemon/conflict-collector"
import type { ConflictPair } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import type { Task } from "../../src/types/task.ts"

/**
 * Conflict radar (docs/design/conflict-radar.md). Load-bearing rules: the
 * O(N²) part is pure in-memory intersection (no git); merge-tree probes run
 * only for L1-hit pairs and are cached by head pair; everything publishes
 * on change only; a pruned task drops its pairs.
 */

const task = (over: Partial<Omit<Task, "id">> & { id?: string }): Task =>
  ({
    id: "t",
    title: "demo",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.kobe/worktrees/demo",
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  }) as Task

const fp = (repo: string, head: string, files: string[]): CardFootprint => ({
  repo,
  head,
  files: new Set(files),
})

describe("pure helpers", () => {
  it("parsePorcelainPaths takes both sides of a rename", () => {
    const out = ' M src/a.ts\nR  src/old.ts -> src/new.ts\n?? "x"\n'
    expect(parsePorcelainPaths(out)).toEqual(["src/a.ts", "src/old.ts", "src/new.ts", '"x"'])
  })

  it("overlapPairs intersects same-repo cards only, sorted ids, sorted files", () => {
    const cards = new Map<string, CardFootprint>([
      ["b", fp("/r1", "h2", ["src/x.ts", "src/y.ts"])],
      ["a", fp("/r1", "h1", ["src/y.ts", "src/z.ts"])],
      ["c", fp("/r2", "h3", ["src/y.ts"])], // other repo — never pairs
      ["d", fp("/r1", "h4", ["docs/readme.md"])], // no intersection
    ])
    expect(overlapPairs(cards)).toEqual([{ a: "a", b: "b", files: ["src/y.ts"], level: "overlap" }])
  })

  it("parseMergeTreeNames reads names between the OID line and the blank", () => {
    expect(parseMergeTreeNames("abc123\nsrc/a.ts\nsrc/b.ts\n\nAuto-merging src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ])
    expect(parseMergeTreeNames("abc123\n")).toEqual([])
  })

  it("sameFootprint compares head + file membership", () => {
    expect(sameFootprint(fp("/r", "h", ["a"]), fp("/r", "h", ["a"]))).toBe(true)
    expect(sameFootprint(fp("/r", "h", ["a"]), fp("/r", "h", ["b"]))).toBe(false)
    expect(sameFootprint(fp("/r", "h1", ["a"]), fp("/r", "h2", ["a"]))).toBe(false)
  })

  it("trackedConflictTasks excludes main/archived/remote/worktree-less", () => {
    const tasks = [
      task({ id: "ok" }),
      task({ id: "main", kind: "main" }),
      task({ id: "arch", archived: true }),
      task({ id: "remote", repo: "ssh://host/repo" }),
      task({ id: "nowt", worktreePath: "" }),
    ]
    expect(trackedConflictTasks(tasks).map((t) => t.id)).toEqual(["ok"])
  })

  it("GitGate caps concurrency FIFO", async () => {
    const gate = new GitGate(1)
    const order: number[] = []
    await Promise.all([
      gate.run(async () => {
        order.push(1)
        await new Promise((r) => setTimeout(r, 10))
        order.push(2)
      }),
      gate.run(async () => {
        order.push(3)
      }),
    ])
    expect(order).toEqual([1, 2, 3])
  })
})

function fakeBus(): { published: ConflictPair[][]; bus: { publish: (ch: string, p: unknown) => void } } {
  const published: ConflictPair[][] = []
  return {
    published,
    bus: {
      publish: (channel: string, payload: unknown) => {
        if (channel === "task.conflicts") published.push((payload as { pairs: ConflictPair[] }).pairs)
      },
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe("ConflictCollector", () => {
  const tasks = [task({ id: "a", worktreePath: "/r/wa" }), task({ id: "b", worktreePath: "/r/wb" })]
  const footprints: Record<string, CardFootprint> = {
    a: fp("/repo", "ha", ["src/auth.ts", "src/db.ts"]),
    b: fp("/repo", "hb", ["src/auth.ts"]),
  }

  function make(opts: {
    probe?: (wt: string, a: string, b: string) => Promise<{ conflict: boolean; files: string[] } | null>
    list?: Task[]
  }) {
    const { published, bus } = fakeBus()
    const probes: string[] = []
    const collector = new ConflictCollector({ listTasks: () => opts.list ?? tasks }, bus as never, {
      cadence: { timeoutMs: 1_000, slowRetryMs: 1_000, minIntervalMs: 0 },
      footprint: async (t) => footprints[t.id as string] as CardFootprint,
      probeMerge:
        opts.probe ??
        (async (_wt, h1, h2) => {
          probes.push(`${h1}|${h2}`)
          return { conflict: true, files: ["src/auth.ts"] }
        }),
    })
    return { collector, published, probes }
  }

  it("publishes overlap, then upgrades to conflict when the probe lands", async () => {
    const { collector, published } = make({})
    collector.tick()
    await settle()
    await settle()
    const last = published[published.length - 1]
    expect(last).toEqual([{ a: "a", b: "b", files: ["src/auth.ts"], level: "conflict" }])
    // The first publish (before the probe resolved) was the L1 overlap.
    expect(published[0]?.[0]?.level).toBe("overlap")
  })

  it("caches the merge probe by head pair — a re-tick with unchanged heads never re-probes", async () => {
    const { collector, probes } = make({})
    collector.tick()
    await settle()
    await settle()
    const count = probes.length
    expect(count).toBe(1)
    collector.tick()
    await settle()
    await settle()
    expect(probes.length).toBe(count)
  })

  it("a clean dry-run keeps the pair at overlap", async () => {
    const { collector, published } = make({
      probe: async () => ({ conflict: false, files: [] }),
    })
    collector.tick()
    await settle()
    await settle()
    const last = published[published.length - 1]
    expect(last?.[0]?.level).toBe("overlap")
  })

  it("an unsupported merge-tree (null) degrades to L1 without erroring", async () => {
    const { collector, published } = make({ probe: async () => null })
    collector.tick()
    await settle()
    await settle()
    expect(published[published.length - 1]?.[0]?.level).toBe("overlap")
  })

  it("pruning a task drops its pairs and republishes", async () => {
    const { published, bus } = fakeBus()
    let list = tasks
    const collector = new ConflictCollector({ listTasks: () => list }, bus as never, {
      cadence: { timeoutMs: 1_000, slowRetryMs: 1_000, minIntervalMs: 0 },
      footprint: async (t) => footprints[t.id as string] as CardFootprint,
      probeMerge: async () => ({ conflict: true, files: ["src/auth.ts"] }),
    })
    collector.tick()
    await settle()
    await settle()
    expect(published.length).toBeGreaterThan(0)
    list = [tasks[0] as Task]
    collector.tick()
    await settle()
    expect(published[published.length - 1]).toEqual([])
  })
})
