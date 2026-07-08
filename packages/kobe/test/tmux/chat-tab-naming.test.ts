/**
 * Per-ChatTab auto-naming (KOB). Drives `runChatTabNamingPass` with a fake
 * TmuxRunner + injected title derivers, against a real Orchestrator + store,
 * so window selection, the recorded-session-id path, the origin fallback, and
 * the manual-rename guard are tested without a live tmux server or on-disk
 * transcripts (those live in the behavior suite).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import {
  CHAT_TAB_LIVE_POLL_MS,
  CHAT_TAB_MISS_CAP_MS,
  CHAT_TAB_MISS_THRESHOLD,
  type ChatTabNamingDeps,
  type ChatTabPollSchedule,
  type TmuxRunner,
  listChatTabWindows,
  nextChatTabPoll,
  runChatTabNamingPass,
} from "../../src/tmux/chat-tab-naming.ts"

let tmpRoot: string
let store: TaskIndexStore
let orch: Orchestrator

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-chattab-"))
  store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

async function makeTask(worktree: string | undefined): Promise<string> {
  const task = await orch.createTask({ repo: "/repo" })
  if (worktree !== undefined) await store.update(task.id, { worktreePath: worktree })
  return task.id
}

/**
 * Fake runner. `windows` is the list-windows reply (one
 * `index\tautoRenameFlag\tsessionId` per line — flag 0 = manually named
 * under a global-on server); `globalAutoRename` is the
 * `show-window-options -g automatic-rename` reply (default on);
 * `autoRenameOff` is the set of window indices whose LOCAL
 * automatic-rename reads off, served to the per-window probe the pass
 * only issues when the flag is ambiguous. Records every rename-window
 * and every show-window-options probe (so tests can assert the batched
 * flag path issues none).
 */
function fakeDeps(opts: {
  windows: string
  globalAutoRename?: "on" | "off"
  autoRenameOff?: number[]
  titleFromSessionId?: (vendor: string, sessionId: string) => string
  titleFromWorktree?: (worktree: string, vendor: string) => string
}): {
  deps: ChatTabNamingDeps
  renames: Array<{ index: string; title: string }>
  optionProbes: string[]
} {
  const renames: Array<{ index: string; title: string }> = []
  const optionProbes: string[] = []
  const off = new Set(opts.autoRenameOff ?? [])
  const runner: TmuxRunner = {
    async capture(args) {
      if (args[0] === "list-windows") return { code: 0, stdout: opts.windows }
      if (args[0] === "show-window-options") {
        if (args.includes("-g")) {
          optionProbes.push("-g")
          return { code: 0, stdout: `automatic-rename ${opts.globalAutoRename ?? "on"}\n` }
        }
        const target = args[args.indexOf("-t") + 1] // =session:index
        optionProbes.push(target)
        const index = Number.parseInt(target.split(":")[1] ?? "", 10)
        return { code: 0, stdout: off.has(index) ? "automatic-rename off\n" : "" }
      }
      return { code: 1, stdout: "" }
    },
    async run(args) {
      if (args[0] === "rename-window") {
        const target = args[args.indexOf("-t") + 1]
        renames.push({ index: target.split(":")[1] ?? "", title: args[args.length - 1] })
      }
      return 0
    },
  }
  return {
    deps: {
      runner,
      titleFromSessionId: async (v, s) => opts.titleFromSessionId?.(v, s) ?? "",
      titleFromWorktree: async (w, v) => opts.titleFromWorktree?.(w, v) ?? "",
    },
    renames,
    optionProbes,
  }
}

describe("listChatTabWindows", () => {
  it("parses index + automatic-rename flag + recorded session id, tolerating empty ids", async () => {
    const runner: TmuxRunner = {
      async capture() {
        return { code: 0, stdout: "1\t1\tabc-123\n2\t0\t\n3\t1\tdef-456\n" }
      },
      async run() {
        return 0
      },
    }
    expect(await listChatTabWindows("kobe-x", runner)).toEqual([
      { index: 1, sessionId: "abc-123", autoRename: "1" },
      { index: 2, sessionId: "", autoRename: "0" },
      { index: 3, sessionId: "def-456", autoRename: "1" },
    ])
  })

  it("returns null when the session is gone (a miss, not an empty listing)", async () => {
    const runner: TmuxRunner = {
      async capture() {
        return { code: 1, stdout: "" }
      },
      async run() {
        return 0
      },
    }
    expect(await listChatTabWindows("kobe-x", runner)).toBeNull()
  })
})

describe("runChatTabNamingPass", () => {
  it("names each window with a recorded session id from its own transcript", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({
      windows: "1\t1\tsess-1\n2\t1\tsess-2\n",
      titleFromSessionId: (_v, s) => (s === "sess-1" ? "first tab" : "second tab"),
    })

    const n = await runChatTabNamingPass(orch, deps)

    expect(n).toBe(2)
    expect(renames).toEqual([
      { index: "1", title: "first tab" },
      { index: "2", title: "second tab" },
    ])
  })

  it("skips a manually-named window from the listing flag alone (no per-window probe)", async () => {
    await makeTask("/wt/a")
    const { deps, renames, optionProbes } = fakeDeps({
      windows: "1\t0\tsess-1\n2\t1\tsess-2\n", // window 1 flag 0 = manually named
      titleFromSessionId: (_v, s) => `title-${s}`,
    })

    await runChatTabNamingPass(orch, deps)

    expect(renames).toEqual([{ index: "2", title: "title-sess-2" }])
    // Global automatic-rename is on, so the flag is conclusive: ONE lazy
    // global probe, zero per-window show-window-options spawns. This is the
    // steady-state spawn budget the batching exists for.
    expect(optionProbes).toEqual(["-g"])
  })

  it("falls back to per-window probes when the GLOBAL automatic-rename is off", async () => {
    await makeTask("/wt/a")
    // Global off ⇒ every window's effective flag expands 0 regardless of the
    // local option, so the flag can't distinguish "manually named" — the
    // pass must ask each window directly, like the pre-batch behavior.
    const { deps, renames, optionProbes } = fakeDeps({
      windows: "1\t0\tsess-1\n2\t0\tsess-2\n",
      globalAutoRename: "off",
      autoRenameOff: [1], // only window 1 is locally off (manually named)
      titleFromSessionId: (_v, s) => `title-${s}`,
    })

    await runChatTabNamingPass(orch, deps)

    expect(renames).toEqual([{ index: "2", title: "title-sess-2" }])
    expect(optionProbes.filter((p) => p !== "-g")).toHaveLength(2)
  })

  it("falls back to the task's first session for the origin window without a recorded id (codex)", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({
      windows: "2\t1\t\n3\t1\t\n", // no recorded ids; lowest index (2) is the origin
      titleFromWorktree: () => "task first prompt",
    })

    await runChatTabNamingPass(orch, deps)

    // Only the origin (index 2) is named; the non-origin id-less window is left.
    expect(renames).toEqual([{ index: "2", title: "task first prompt" }])
  })

  it("does not rename when the derived title is empty (no prompt yet)", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({ windows: "1\t1\tsess-1\n", titleFromSessionId: () => "" })
    expect(await runChatTabNamingPass(orch, deps)).toBe(0)
    expect(renames).toEqual([])
  })

  it("skips an archived task before any tmux/disk work", async () => {
    const id = await makeTask("/wt/a")
    await store.update(id, { archived: true })
    const { deps, renames } = fakeDeps({ windows: "1\t1\tsess-1\n", titleFromSessionId: () => "should not run" })
    await runChatTabNamingPass(orch, deps)
    expect(renames).toEqual([])
  })

  it("skips a task that has no worktree yet", async () => {
    await makeTask(undefined) // a task with no worktree yet
    const { deps, renames } = fakeDeps({ windows: "1\t1\tsess-1\n", titleFromSessionId: () => "should not run" })
    await runChatTabNamingPass(orch, deps)
    expect(renames).toEqual([])
  })
})

/** Cancel jitter (rand 0.5 → no offset) so the scheduled delays are exact. */
const noJitter = (): number => 0.5

/** A runner whose `list-windows` always fails, like a session that's gone. `calls` counts list-windows spawns. */
function deadSessionDeps(): { deps: ChatTabNamingDeps; calls: { listWindows: number } } {
  const calls = { listWindows: 0 }
  const runner: TmuxRunner = {
    async capture(args) {
      if (args[0] === "list-windows") calls.listWindows++
      return { code: 1, stdout: "" }
    },
    async run() {
      return 0
    },
  }
  return { deps: { runner, titleFromSessionId: async () => "", titleFromWorktree: async () => "" }, calls }
}

describe("nextChatTabPoll", () => {
  it("resets the miss streak and schedules full cadence on a found session", () => {
    const entry = nextChatTabPoll(true, 5, 1_000, noJitter)
    expect(entry).toEqual({ nextAllowedAt: 1_000 + CHAT_TAB_LIVE_POLL_MS, misses: 0 })
  })

  it("keeps full cadence for misses under the threshold", () => {
    expect(nextChatTabPoll(false, 0, 1_000, noJitter).nextAllowedAt).toBe(1_000 + CHAT_TAB_LIVE_POLL_MS)
    expect(nextChatTabPoll(false, 1, 1_000, noJitter).nextAllowedAt).toBe(1_000 + CHAT_TAB_LIVE_POLL_MS)
    expect(nextChatTabPoll(false, 0, 1_000, noJitter).misses).toBe(1)
    expect(nextChatTabPoll(false, 1, 1_000, noJitter).misses).toBe(2)
  })

  it("backs off once the miss streak reaches the threshold, capped", () => {
    // prevMisses = THRESHOLD - 1 → this call's streak hits THRESHOLD exactly:
    // the first backoff step, which equals the base delay (same as live
    // cadence) — the exponential growth starts on the NEXT miss.
    const atThreshold = nextChatTabPoll(false, CHAT_TAB_MISS_THRESHOLD - 1, 1_000, noJitter)
    expect(atThreshold.misses).toBe(CHAT_TAB_MISS_THRESHOLD)
    expect(atThreshold.nextAllowedAt).toBe(1_000 + CHAT_TAB_LIVE_POLL_MS)

    // One more miss past the threshold: backoff strictly grows beyond cadence.
    const oneMorePastThreshold = nextChatTabPoll(false, CHAT_TAB_MISS_THRESHOLD, 1_000, noJitter)
    expect(oneMorePastThreshold.nextAllowedAt).toBeGreaterThan(1_000 + CHAT_TAB_LIVE_POLL_MS)

    // Keeps growing but never exceeds the cap.
    const wayPastThreshold = nextChatTabPoll(false, CHAT_TAB_MISS_THRESHOLD + 20, 1_000, noJitter)
    expect(wayPastThreshold.nextAllowedAt).toBe(1_000 + CHAT_TAB_MISS_CAP_MS)
  })

  it("never evicts permanently — a found session after a long miss streak resets to full cadence", () => {
    const stillBackedOff = nextChatTabPoll(false, 50, 1_000, noJitter)
    expect(stillBackedOff.nextAllowedAt).toBe(1_000 + CHAT_TAB_MISS_CAP_MS)
    const found = nextChatTabPoll(true, stillBackedOff.misses, 2_000, noJitter)
    expect(found).toEqual({ nextAllowedAt: 2_000 + CHAT_TAB_LIVE_POLL_MS, misses: 0 })
  })
})

describe("runChatTabNamingPass — dead-session backoff (daemon issue #27)", () => {
  it("stops calling list-windows for a task once its miss streak backs off past `now`", async () => {
    const id = await makeTask("/wt/a")
    const { deps, calls } = deadSessionDeps()
    const schedule: ChatTabPollSchedule = new Map()
    let now = 0

    // First CHAT_TAB_MISS_THRESHOLD + 1 ticks: at full cadence until the
    // streak crosses the threshold, so each one issues a list-windows call
    // and grows the streak. The +1 pushes the backoff strictly past cadence
    // (the threshold-exact step equals cadence itself — see nextChatTabPoll's
    // own test — so the very next miss is where it first exceeds `now`).
    const ticks = CHAT_TAB_MISS_THRESHOLD + 1
    for (let i = 0; i < ticks; i++) {
      await runChatTabNamingPass(orch, deps, schedule, now, noJitter)
      now += CHAT_TAB_LIVE_POLL_MS
    }
    expect(calls.listWindows).toBe(ticks)
    expect(schedule.get(id)?.misses).toBe(ticks)
    const backedOffUntil = schedule.get(id)?.nextAllowedAt ?? 0
    expect(backedOffUntil).toBeGreaterThan(now)

    // A tick landing before the backoff elapses must NOT call list-windows
    // again — this is the fix for daemon issue #27's tight per-tick retry
    // against a session that's been gone for hours.
    await runChatTabNamingPass(orch, deps, schedule, now, noJitter)
    expect(calls.listWindows).toBe(ticks)
  })

  it("evicts by capped backoff, never removes the task from the poll set outright", async () => {
    const id = await makeTask("/wt/a")
    const { deps } = deadSessionDeps()
    const schedule: ChatTabPollSchedule = new Map()
    let now = 0

    // Drive many ticks — every dead-session tick jumps `now` to the entry's
    // own nextAllowedAt so each call is a real probe, not a skipped one.
    for (let i = 0; i < 10; i++) {
      await runChatTabNamingPass(orch, deps, schedule, now, noJitter)
      const entry = schedule.get(id)
      expect(entry).toBeDefined()
      now = entry?.nextAllowedAt ?? now + CHAT_TAB_LIVE_POLL_MS
    }
    const entry = schedule.get(id)
    // The task is still IN the schedule (not evicted) and its cadence has
    // settled at the cap, not kept growing or vanishing.
    expect(entry).toBeDefined()
    expect(entry?.nextAllowedAt).toBeLessThanOrEqual(now + CHAT_TAB_MISS_CAP_MS)
  })

  it("resets the miss streak the moment a session reappears", async () => {
    const id = await makeTask("/wt/a")
    const dead = deadSessionDeps()
    const schedule: ChatTabPollSchedule = new Map()
    let now = 0
    for (let i = 0; i < CHAT_TAB_MISS_THRESHOLD; i++) {
      await runChatTabNamingPass(orch, dead.deps, schedule, now, noJitter)
      now = schedule.get(id)?.nextAllowedAt ?? now + CHAT_TAB_LIVE_POLL_MS
    }
    expect(schedule.get(id)?.misses).toBe(CHAT_TAB_MISS_THRESHOLD)

    // The session comes back (user re-entered the task): list-windows now succeeds.
    const { deps: liveDeps } = fakeDeps({ windows: "1\t1\tsess-1\n", titleFromSessionId: () => "" })
    await runChatTabNamingPass(orch, liveDeps, schedule, now, noJitter)
    expect(schedule.get(id)).toEqual({ nextAllowedAt: now + CHAT_TAB_LIVE_POLL_MS, misses: 0 })
  })

  it("proactively drops an archived task's entry from the schedule (req 2)", async () => {
    const id = await makeTask("/wt/a")
    const { deps } = deadSessionDeps()
    const schedule: ChatTabPollSchedule = new Map()
    await runChatTabNamingPass(orch, deps, schedule, 0, noJitter)
    expect(schedule.has(id)).toBe(true)

    await store.update(id, { archived: true })
    await runChatTabNamingPass(orch, deps, schedule, CHAT_TAB_LIVE_POLL_MS, noJitter)
    expect(schedule.has(id)).toBe(false)
  })

  it("proactively drops a deleted task's entry from the schedule (req 2)", async () => {
    const id = await makeTask("/wt/a")
    const { deps } = deadSessionDeps()
    const schedule: ChatTabPollSchedule = new Map()
    await runChatTabNamingPass(orch, deps, schedule, 0, noJitter)
    expect(schedule.has(id)).toBe(true)

    // store.remove (not orch.deleteTask) — deletion here only needs the task
    // gone from orch.listTasks(); the real worktree-removal safety ladder is
    // core-mutations.test.ts's concern, and this suite's fake worktree paths
    // aren't real git worktrees for deleteTask to operate on.
    await store.remove(id)
    await runChatTabNamingPass(orch, deps, schedule, CHAT_TAB_LIVE_POLL_MS, noJitter)
    expect(schedule.has(id)).toBe(false)
  })
})
