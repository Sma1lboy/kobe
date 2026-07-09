/**
 * Daemon transcript-activity collector (perf — deduplicate per-Ops-pane
 * polling) — the single filesystem collector that replaces every Ops pane
 * stat'ing + parsing the transcript store on its own timers. What matters:
 *
 *   - **Scope + vendor pick**: archived tasks and remote (`ssh://`) projects
 *     are never collected; tasks sharing a worktree path collapse to one
 *     slot and the FIRST task in list order picks the vendor (completion
 *     markers are vendor-specific).
 *   - **Publish-on-change only**: a probe round-tripping to the same facts
 *     publishes nothing — subscribed Ops panes must not re-run effects on
 *     unchanged ticks.
 *   - **Pruning**: a task deleted/archived between ticks drops its entry
 *     (with a republish), and a probe completing AFTER its entry was pruned
 *     must not resurrect it.
 *   - **In-flight dedupe + subscriber gate**: ticks landing mid-probe start
 *     nothing; a gui-less daemon (no subscribers) does no work at all.
 *
 * The probe is injected (no real transcripts / fs); the cadence floor is
 * zeroed so successive ticks are immediately eligible. The pure timing math
 * is covered by the shared poll-scheduling tests — this file pins the
 * collector's pass logic. The per-window capture-pane → @kobe_tab_state chip
 * stays MANUAL (it needs a real tmux pane and lives in `ops/host.tsx`, never
 * daemon-side).
 */

import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { TranscriptActivityPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  TranscriptActivityCollector,
  type TranscriptActivityEntry,
  runTranscriptActivity,
  sameTranscriptActivityEntry,
  trackedWorktrees,
} from "@sma1lboy/kobe-daemon/daemon/transcript-activity-collector"
import { describe, expect, test } from "vitest"
import {
  type HistoryDeps as CodexHistoryDeps,
  findLatestRolloutForWorktree,
  latestTranscriptMtimeForWorktree,
} from "../../src/engine/codex-local/history.ts"
import { CodexTurnDetector } from "../../src/engine/turn-detector.ts"
import { type Task, type VendorId, toTaskId } from "../../src/types/task.ts"

/** Minimal Task — only the fields the collector reads. */
function task(over: Omit<Partial<Task>, "id"> & { id: string }): Task {
  const { id, ...rest } = over
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repo",
    branch: id,
    worktreePath: `/wt/${id}`,
    vendor: "claude",
    status: "backlog",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  } as Task
}

/** Cadence with a zero floor so every tick is immediately eligible. */
const FAST = { timeoutMs: 1_000, slowRetryMs: 1_000, minIntervalMs: 0 }

/** Let the collector's fire-and-forget probe completions settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function harness(initialTasks: Task[], facts: Record<string, TranscriptActivityEntry>) {
  let tasks = initialTasks
  const bus = new DaemonEventBus()
  const published: TranscriptActivityPayload[] = []
  bus.onPublish((event) => {
    if (event.channel === "transcript.activity") published.push(event.payload as TranscriptActivityPayload)
  })
  const runs: Array<{ path: string; vendor: VendorId }> = []
  const collector = new TranscriptActivityCollector({ listTasks: () => tasks }, bus, {
    cadence: FAST,
    run: async (worktreePath, vendor) => {
      runs.push({ path: worktreePath, vendor })
      const value = facts[worktreePath]
      if (!value) throw new Error("transcript probe failed")
      return value
    },
  })
  const setTasks = (next: Task[]): void => {
    tasks = next
  }
  return { collector, published, runs, facts, setTasks }
}

const entry = (mtimeMs: number, completionId: string | null = null, completionAt = 0): TranscriptActivityEntry => ({
  mtimeMs,
  completionId,
  completionAt,
})

describe("trackedWorktrees", () => {
  test("excludes archived/remote/empty, dedupes shared paths, carries the vendor", () => {
    const tasks = [
      task({ id: "a", vendor: "codex" }),
      task({ id: "arch", archived: true }),
      task({ id: "remote", repo: "ssh://dev@build-box", worktreePath: "/remote/wt/remote" }),
      task({ id: "backlog", worktreePath: "" }),
      // Two rows sharing a worktree path — the first in list order wins.
      task({ id: "main1", kind: "main", repo: "/repo", worktreePath: "/repo", vendor: "claude" }),
      task({ id: "main2", kind: "main", repo: "/repo", worktreePath: "/repo", vendor: "codex" }),
    ]
    const map = trackedWorktrees(tasks)
    expect([...map.keys()].sort()).toEqual(["/repo", "/wt/a"])
    expect(map.get("/wt/a")).toBe("codex")
    // First task at the shared path (main1, vendor claude) picks the vendor.
    expect(map.get("/repo")).toBe("claude")
  })

  test("a task without a vendor normalizes to the default (claude)", () => {
    const map = trackedWorktrees([task({ id: "a", vendor: undefined })])
    expect(map.get("/wt/a")).toBe("claude")
  })
})

describe("sameTranscriptActivityEntry", () => {
  test("compares all three fields", () => {
    expect(sameTranscriptActivityEntry(entry(5, "c1", 9), entry(5, "c1", 9))).toBe(true)
    expect(sameTranscriptActivityEntry(entry(5, "c1", 9), entry(6, "c1", 9))).toBe(false)
    expect(sameTranscriptActivityEntry(entry(5, "c1", 9), entry(5, "c2", 9))).toBe(false)
    expect(sameTranscriptActivityEntry(entry(5, "c1", 9), entry(5, "c1", 10))).toBe(false)
  })
})

describe("TranscriptActivityCollector", () => {
  test("collects local non-archived worktrees, passes the vendor, publishes the full map", async () => {
    const { collector, published, runs } = harness(
      [task({ id: "a", vendor: "codex" }), task({ id: "arch", archived: true })],
      { "/wt/a": entry(100, "c1", 99) },
    )
    collector.tick()
    await settle()
    expect(runs).toEqual([{ path: "/wt/a", vendor: "codex" }])
    expect(published.at(-1)).toEqual({ activity: { "/wt/a": { mtimeMs: 100, completionId: "c1", completionAt: 99 } } })
  })

  test("publishes only when the facts actually changed", async () => {
    const { collector, published, facts } = harness([task({ id: "a" })], { "/wt/a": entry(10, null, 0) })
    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    // Same facts again → no publish (panes must not re-run effects on noise).
    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    // mtime advanced → publish.
    facts["/wt/a"] = entry(20, "c1", 18)
    collector.tick()
    await settle()
    expect(published.length).toBe(2)
    expect(published.at(-1)).toEqual({ activity: { "/wt/a": { mtimeMs: 20, completionId: "c1", completionAt: 18 } } })
  })

  test("a failing probe keeps the last published value (never errors, never publishes garbage)", async () => {
    const { collector, published, facts } = harness([task({ id: "a" })], { "/wt/a": entry(10, "c1", 9) })
    collector.tick()
    await settle()
    expect(published.length).toBe(1)

    facts["/wt/a"] = undefined as unknown as TranscriptActivityEntry
    collector.tick()
    await settle()
    expect(published.length).toBe(1)
  })

  test("drops a deleted/archived task's entry from the published map", async () => {
    const { collector, published, setTasks } = harness([task({ id: "a" }), task({ id: "b" })], {
      "/wt/a": entry(1, "ca", 1),
      "/wt/b": entry(2, "cb", 2),
    })
    collector.tick()
    await settle()
    expect(Object.keys(published.at(-1)?.activity ?? {}).sort()).toEqual(["/wt/a", "/wt/b"])

    setTasks([task({ id: "a" }), task({ id: "b", archived: true })])
    collector.tick()
    await settle()
    expect(published.at(-1)).toEqual({ activity: { "/wt/a": { mtimeMs: 1, completionId: "ca", completionAt: 1 } } })
  })

  test("dedupes in-flight probes — a tick landing mid-probe starts nothing", async () => {
    let release: ((v: TranscriptActivityEntry) => void) | undefined
    const bus = new DaemonEventBus()
    const runs: string[] = []
    const collector = new TranscriptActivityCollector({ listTasks: () => [task({ id: "a" })] }, bus, {
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
    release?.(entry(0))
    await settle()
  })

  test("a probe completing after its task was pruned does not resurrect the entry", async () => {
    let release: ((v: TranscriptActivityEntry) => void) | undefined
    const tasks = { current: [task({ id: "a" })] }
    const bus = new DaemonEventBus()
    const published: TranscriptActivityPayload[] = []
    bus.onPublish((event) => {
      if (event.channel === "transcript.activity") published.push(event.payload as TranscriptActivityPayload)
    })
    const collector = new TranscriptActivityCollector({ listTasks: () => tasks.current }, bus, {
      cadence: FAST,
      run: () =>
        new Promise((r) => {
          release = r
        }),
    })
    collector.tick() // starts the probe
    tasks.current = [] // task deleted while the probe runs
    collector.tick() // prunes the (valueless) entry
    release?.(entry(50, "c", 50))
    await settle()
    expect(published).toEqual([])
  })

  test("pauses entirely while hasSubscribers is false, resumes when true", async () => {
    let subscribed = false
    const bus = new DaemonEventBus()
    const published: TranscriptActivityPayload[] = []
    bus.onPublish((event) => {
      if (event.channel === "transcript.activity") published.push(event.payload as TranscriptActivityPayload)
    })
    const runs: string[] = []
    const collector = new TranscriptActivityCollector({ listTasks: () => [task({ id: "a" })] }, bus, {
      cadence: FAST,
      hasSubscribers: () => subscribed,
      run: async (worktreePath) => {
        runs.push(worktreePath)
        return entry(7, "c", 7)
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
    expect(published.at(-1)).toEqual({ activity: { "/wt/a": { mtimeMs: 7, completionId: "c", completionAt: 7 } } })
  })

  test("tick never throws when the task lister blows up", () => {
    const bus = new DaemonEventBus()
    const collector = new TranscriptActivityCollector(
      {
        listTasks: () => {
          throw new Error("store exploded")
        },
      },
      bus,
      { cadence: FAST, run: async () => entry(0) },
    )
    expect(() => collector.tick()).not.toThrow()
  })

  test("stop() halts further publishing", async () => {
    const { collector, published } = harness([task({ id: "a" })], { "/wt/a": entry(10, "c", 9) })
    collector.stop()
    collector.tick()
    await settle()
    expect(published).toEqual([])
  })
})

/**
 * The perf fix this suite guards: `runTranscriptActivity` used to make TWO
 * independent walks of the same codex `sessions` date-tree per probe —
 * `latestTranscriptMtime` (a full tree readdir) then `detector.latestCompletion`
 * (another full tree readdir + a stat). The detector already computes the
 * newest mtime while finding the completion, so one `detector.latestActivity`
 * call now yields both — ONE tree walk, HALF the stats. This is a deterministic
 * call-count assertion (readdir/stat spies), not a wall-clock benchmark; a
 * regression that re-introduces the second walk fails the readdir count.
 */
describe("runTranscriptActivity — single codex tree walk", () => {
  const WT = "/wt"
  // One rollout under a single day dir, matching the worktree cwd, with a
  // turn.completed marker so the returned entry carries a completionId.
  const ROLLOUT = "rollout-2026-05-29T02-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl"
  const RAW = JSON.stringify({ type: "turn.completed", timestamp: "2026-05-29T02:00:03.000Z", usage: {} })

  /** Codex `HistoryDeps` that counts every readdir/readFile/stat. */
  function countingDeps() {
    const counts = { readdir: 0, readFile: 0, stat: 0, treeReaddir: 0 }
    const deps: CodexHistoryDeps = {
      sessionsDir: () => "/sessions",
      readdir: async (p) => {
        counts.readdir++
        // A full tree walk touches exactly these four dirs, in order.
        if (p === "/sessions") return ["2026"]
        if (p === "/sessions/2026") return ["05"]
        if (p === "/sessions/2026/05") return ["29"]
        if (p === "/sessions/2026/05/29") {
          counts.treeReaddir++
          return [ROLLOUT]
        }
        return []
      },
      readFile: async () => {
        counts.readFile++
        return `${JSON.stringify({ type: "session_meta", payload: { cwd: WT } })}\n${RAW}`
      },
      stat: async () => {
        counts.stat++
        return { mtimeMs: 2000 }
      },
    }
    // The detector's deps (findLatestRollout / readFile) delegate into the
    // SAME counting HistoryDeps, so a detector probe drives (and counts) a
    // real codex date-tree walk exactly as production does.
    const detector = new CodexTurnDetector({
      findLatestRollout: (wt) => findLatestRolloutForWorktree(wt, deps),
      readFile: (p) => deps.readFile(p),
    })
    return { deps, counts, detector }
  }

  test("probes the date-tree once and returns byte-identical facts to the old two-walk path", async () => {
    // Correctness pin: recompute the OLD path's result (mtime from the
    // standalone reader + marker from the detector) over an INDEPENDENT deps
    // instance, then assert the fused single-walk probe matches it exactly.
    const oldSide = countingDeps()
    const oldMtime = await latestTranscriptMtimeForWorktree(WT, oldSide.deps)
    const oldMarker = await oldSide.detector.latestCompletion(WT)
    const expected: TranscriptActivityEntry = {
      mtimeMs: oldMtime,
      completionId: oldMarker?.id ?? null,
      completionAt: oldMarker?.timestampMs ?? 0,
    }
    // The old path walked the day dir TWICE (once per reader).
    expect(oldSide.counts.treeReaddir).toBe(2)

    const newSide = countingDeps()
    const got = await runTranscriptActivity(WT, "codex", newSide.detector, new AbortController().signal)

    expect(got).toEqual(expected)
    // AFTER the fix: exactly ONE day-dir readdir, and half the stats.
    expect(newSide.counts.treeReaddir).toBe(1)
    expect(newSide.counts.stat).toBe(oldSide.counts.stat / 2)
  })
})
