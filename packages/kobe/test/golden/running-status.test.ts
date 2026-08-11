/**
 * Golden behavior — session events → sidebar running state, anchored end to
 * end (issue #11 Phase 1). Each case feeds a REAL hook-event sequence through
 * the daemon's activity registry, over the actual `engine-state` wire payload,
 * into the client accumulator, and derives what a sidebar TAB row renders
 * (`tabRowActivity` + `buildSidebarRowView`) — the same chain a live TUI runs.
 *
 * These are the Phase 1 stakes for the 2026-08-10/11 activity fixes
 * (a85f0919 don't-borrow-a-sibling's-spinner, a4f901d5 cold-registry Stop,
 * 49dfec84 session-scoped liveness). Deliberately asserted at DISPLAY level:
 * Phase 2 (output heartbeat / unknown state / reconciler) may add signal for
 * rows that previously showed nothing, but must never change what these
 * sequences render.
 */

import {
  type ActivityLivenessProbe,
  DaemonActivityRegistry,
  type EngineStatePayload,
} from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, describe, expect, it } from "vitest"
import { handleOrchestratorEvent } from "../../src/client/remote-orchestrator-events"
import type {
  EngineTabStateMap,
  OrchestratorSignals,
  TaskEngineState,
} from "../../src/client/remote-orchestrator-payloads"
import { createStateCell } from "../../src/lib/external-store"
import { buildSidebarRowView } from "../../src/tui/panes/sidebar/row-view"
import { tabRowActivity } from "../../src/tui/panes/sidebar/tree-core"
import { type Task, toTaskId } from "../../src/types/task"

const TASK_ID = "task-1"

const TASK: Task = {
  id: toTaskId(TASK_ID),
  title: "fix sidebar",
  repo: "/repo/kobe",
  branch: "feature/sidebar",
  worktreePath: "/repo/kobe/worktrees/sidebar",
  kind: "task",
  status: "backlog",
  archived: false,
  pinned: false,
  vendor: "claude",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Task

interface RowOpts {
  readonly active?: boolean
  readonly completionSeen?: boolean
  readonly transcript?: { readonly mtimeMs: number }
}

/** One daemon + one attached client, wired over the real wire payloads. */
function harness(opts: { staleMs?: number; probe?: ActivityLivenessProbe } = {}) {
  const bus = new DaemonEventBus()
  const published: EngineStatePayload[] = []

  const makeClient = () => {
    const engineState = createStateCell<ReadonlyMap<string, TaskEngineState>>(new Map())
    const engineTabState = createStateCell<EngineTabStateMap>(new Map())
    const lifecycle = createStateCell<ReadonlyMap<string, { readonly subagents: number }>>(new Map())
    const signals = {
      engineStateAcc: engineState,
      setEngineStateSig: engineState.set,
      engineTabStateAcc: engineTabState,
      setEngineTabStateSig: engineTabState.set,
      engineLifecycleAcc: lifecycle,
      setEngineLifecycleSig: lifecycle.set,
    } as unknown as OrchestratorSignals
    // What TabTreeRow computes for one tab row of TASK.
    const row = (tabId: string, o: RowOpts = {}) => {
      const tabs = engineTabState().get(TASK_ID)
      const activity = tabRowActivity({
        tabActivity: tabs?.get(tabId),
        reportedTabCount: tabs?.size ?? 0,
        taskActivity: engineState().get(TASK_ID),
        active: o.active === true,
      })
      const view = buildSidebarRowView({
        task: TASK,
        activity,
        spinnerFrame: 0,
        subtitleBudget: 60,
        truncateBranch: (b) => b,
        completionSeen: o.completionSeen === true,
        transcript: o.transcript,
      })
      return { activity, loading: view.loading, glyph: view.stateGlyph, tone: view.tone }
    }
    return { signals, row }
  }

  const client = makeClient()
  bus.onPublish((event) => {
    if (event.channel !== "engine-state") return
    published.push(event.payload as EngineStatePayload)
    handleOrchestratorEvent("engine-state", event.payload, client.signals)
  })
  const registry = new DaemonActivityRegistry(bus, opts.staleMs, undefined, opts.probe)
  return { registry, published, row: client.row, makeClient }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const registries: DaemonActivityRegistry[] = []
const track = <T extends { registry: DaemonActivityRegistry }>(h: T): T => {
  registries.push(h.registry)
  return h
}
afterEach(() => {
  for (const r of registries.splice(0)) r.close()
})

describe("golden: session events → sidebar running state", () => {
  it("a turn-start spins exactly the reporting tab's row", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    const row = h.row("tab-1")
    expect(row.loading).toBe(true)
    expect(row.tone).toBe("primary")
    const last = h.published.at(-1)
    expect(last).toMatchObject({ taskId: TASK_ID, tabId: "tab-1", state: "running", sessionId: "s1" })
  })

  it("a Stop after running lands the unseen ●, which digests once seen", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1")
    h.registry.report(TASK_ID, "turn-complete", undefined, "tab-1")
    const unseen = h.row("tab-1")
    expect(unseen.loading).toBe(false)
    expect(unseen.glyph).toBe("●")
    expect(unseen.tone).toBe("primary")
    const seen = h.row("tab-1", { completionSeen: true })
    expect(seen.glyph).toBe("○")
    expect(seen.tone).toBe("textMuted")
  })

  it("a Stop on a COLD registry completes the turn (fresh daemon, a4f901d5)", () => {
    // The one real way a task's first event is a Stop: the turn started
    // before a daemon restart wiped the in-memory registry. The ● lamp must
    // not be eaten.
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-complete", undefined, "tab-1")
    expect(h.row("tab-1").glyph).toBe("●")
  })

  it("a Stop on a KNOWN-idle state stays swallowed (automated wake)", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "session-start", undefined, "tab-1")
    h.registry.report(TASK_ID, "turn-complete", undefined, "tab-1")
    const row = h.row("tab-1", { active: true })
    expect(row.loading).toBe(false)
    expect(row.glyph).not.toBe("●")
  })

  it("an interrupt drops the spinner without a completion lamp", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1")
    expect(h.row("tab-1").loading).toBe(true)
    h.registry.report(TASK_ID, "turn-interrupted", undefined, "tab-1")
    const row = h.row("tab-1", { active: true })
    expect(row.loading).toBe(false)
    expect(row.glyph).not.toBe("●")
  })

  it("attention states are sticky words, not spinners — and never lapse-policed", () => {
    const perm = track(harness())
    perm.registry.report(TASK_ID, "awaiting-input", { waiting: "permission" }, "tab-1")
    const permRow = perm.row("tab-1")
    expect(permRow).toMatchObject({ loading: false, glyph: "?", tone: "warning" })
    // Sticky: no lapse watchdog armed — an engine blocked on the user writes
    // nothing, and the old watchdog idled exactly the tasks needing a human.
    expect(perm.registry.debugSnapshot().tasks[TASK_ID]?.lapseArmed).toBe(false)
    expect(perm.registry.debugSnapshot().tabs[TASK_ID]?.["tab-1"]?.lapseArmed).toBe(false)

    const limited = track(harness())
    limited.registry.report(TASK_ID, "turn-failed", { failure: "rate_limit" }, "tab-1")
    expect(limited.row("tab-1")).toMatchObject({ loading: false, glyph: "◷", tone: "warning" })

    const errored = track(harness())
    errored.registry.report(TASK_ID, "turn-failed", { failure: "other" }, "tab-1")
    expect(errored.row("tab-1")).toMatchObject({ loading: false, glyph: "✕", tone: "error" })
  })

  it("a tab row never borrows a sibling's spinner (a85f0919)", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1")
    // tab-2 is the ACTIVE tab and has no entry of its own; once ANY tab of
    // the task has reported, the task rollup means "whichever tab moved
    // last" and must not light this row.
    const other = h.row("tab-2", { active: true })
    expect(other.activity).toBeUndefined()
    expect(other.loading).toBe(false)
    // The reporting tab keeps its own spinner whether or not it is active.
    expect(h.row("tab-1", { active: false }).loading).toBe(true)
  })

  it("an untagged session (no tabId) reaches only the ACTIVE tab row", () => {
    // A hand-typed `claude` in a shell inherits no KOBE_TAB_ID: its events
    // are task-level only, and the rollup may stand in for the active tab
    // of a task where NO tab has ever reported.
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start")
    expect(h.row("tab-1", { active: true }).loading).toBe(true)
    expect(h.row("tab-2", { active: false }).loading).toBe(false)
  })

  it("the lapse watchdog probes THIS session's transcript, then idles (49dfec84)", async () => {
    const probed: Array<string | undefined> = []
    const probe: ActivityLivenessProbe = (_taskId, _vendor, transcriptPath) => {
      probed.push(transcriptPath)
      return Promise.resolve(undefined) // silent engine → lapse
    }
    const h = track(harness({ staleMs: 25, probe }))
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1", { id: "s1", transcriptPath: "/t/s1.jsonl" }, "claude")
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-2", { id: "s2", transcriptPath: "/t/s2.jsonl" }, "claude")
    await wait(120)
    // Each tab's watchdog asked about ITS OWN session transcript — inheriting
    // the task rollup leaked another tab's session onto the probe.
    expect(probed).toContain("/t/s1.jsonl")
    expect(probed).toContain("/t/s2.jsonl")
    // Both rows dropped their spinner; the per-tab idle went over the wire.
    expect(h.published.some((p) => p.tabId === "tab-1" && p.state === "idle")).toBe(true)
    expect(h.published.some((p) => p.tabId === "tab-2" && p.state === "idle")).toBe(true)
    expect(h.row("tab-1").loading).toBe(false)
    expect(h.row("tab-2").loading).toBe(false)
  })

  it("a fresh transcript write re-arms the watchdog instead of idling a long turn", async () => {
    const h = track(harness({ staleMs: 40, probe: () => Promise.resolve({ mtimeMs: Date.now() }) }))
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    await wait(120)
    expect(h.row("tab-1").loading).toBe(true)
  })

  it("a completion marker at/after turn start ends the lapse regardless of fresh writes", async () => {
    const h = track(
      harness({ staleMs: 25, probe: () => Promise.resolve({ mtimeMs: Date.now(), completedAt: Date.now() }) }),
    )
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    await wait(120)
    expect(h.row("tab-1").loading).toBe(false)
  })

  it("a 'complete' whose transcript kept growing is still working (grace)", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1")
    h.registry.report(TASK_ID, "turn-complete", undefined, "tab-1")
    const at = h.published.at(-1)?.at ?? 0
    // Transcript wrote on AFTER the completion hook + grace: not done yet.
    const busy = h.row("tab-1", { transcript: { mtimeMs: at + 5000 } })
    expect(busy.loading).toBe(true)
    expect(busy.glyph).not.toBe("●")
    // Settled: the completion outlives the last write.
    const done = h.row("tab-1", { transcript: { mtimeMs: at + 500 } })
    expect(done.loading).toBe(false)
    expect(done.glyph).toBe("●")
  })

  it("replay lights a late subscriber's rows (reattach without new events)", () => {
    const h = track(harness())
    h.registry.report(TASK_ID, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    // A fresh client attaches: no live events, only the subscribe-time replay.
    const late = h.makeClient()
    for (const payload of h.registry.currentNonIdle()) {
      handleOrchestratorEvent("engine-state", payload, late.signals)
    }
    expect(late.row("tab-1").loading).toBe(true)
  })
})
