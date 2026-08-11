/**
 * Daemon activity observer (issues #11/#16) — the PTY output heartbeat +
 * foreground-walk reconciler behind the sidebar running dots. Behavior-
 * driven: a fake pty-host inventory + walk feed the real observer loop, a
 * real registry + bus carry the wire payloads, and assertions land on what
 * a sidebar tab row derives — the same chain the golden stakes anchor.
 */

import { startActivityObserver } from "@sma1lboy/kobe-daemon/daemon/activity-observer"
import { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, describe, expect, it } from "vitest"
import { handleOrchestratorEvent } from "../../src/client/remote-orchestrator-events"
import type {
  EngineTabStateMap,
  OrchestratorSignals,
  TaskEngineState,
} from "../../src/client/remote-orchestrator-payloads"
import { engineTitleTurnHint } from "../../src/engine/registry"
import { createStateCell } from "../../src/lib/external-store"
import { tabRowActivity } from "../../src/tui/panes/sidebar/tree-core"

const TASK = "task-1"
const KEY = `${TASK}::tab-1`

interface FakeSession {
  key: string
  alive: boolean
  pid: number | null
  title: string
  totalBytes: number
}

function world(opts: { silenceMs?: number; correctAfterMs?: number } = {}) {
  const bus = new DaemonEventBus()
  const registry = new DaemonActivityRegistry(bus)
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
  bus.onPublish((event) => {
    if (event.channel === "engine-state") handleOrchestratorEvent("engine-state", event.payload, signals)
  })

  // Mutable fake pty-host + walk table the tests steer.
  const state = {
    sessions: [] as FakeSession[] | null,
    engines: new Map<number, string | null>(),
  }
  const stop = startActivityObserver(
    registry,
    {
      listSessions: () => Promise.resolve(state.sessions),
      foregroundEngines: (pids) => {
        const out = new Map<number, string | null>()
        for (const pid of pids) out.set(pid, state.engines.get(pid) ?? null)
        return Promise.resolve(out)
      },
      titleTurnHint: engineTitleTurnHint,
    },
    () => true,
    {
      pollMs: 15,
      silenceMs: opts.silenceMs ?? 60,
      correctAfterMs: opts.correctAfterMs ?? 0,
      walkEveryTicks: 2,
      log: () => {},
    },
  )
  cleanups.push(stop, () => registry.close())

  /** The sidebar tab-row inputs for TASK/tabId — the display-level read. */
  const row = (tabId: string) => {
    const tabs = engineTabState().get(TASK)
    return tabRowActivity({
      tabActivity: tabs?.get(tabId),
      reportedTabCount: tabs?.size ?? 0,
      taskActivity: engineState().get(TASK),
      active: true,
    })
  }
  return { registry, state, row, taskRollup: () => engineState().get(TASK) }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

const waitFor = async (cond: () => boolean, timeoutMs = 1500): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("activity observer", () => {
  it("re-seeds a busy session's dot on the first pass after a daemon restart (#16)", async () => {
    // Fresh registry (the restart wiped it); the engine is mid-turn: alive,
    // foreground claude, working title frame. No hook event will come until
    // the next turn boundary — the walk + title frame must light the row.
    const w = world()
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "⠂ 修复构建失败", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await waitFor(() => w.row("tab-1")?.state === "running")
    expect(w.taskRollup()?.state).toBe("running")
  })

  it("flips a hook-claimed running to idle when the engine title rests (ESC, daemon-side)", async () => {
    const w = world()
    w.registry.report(TASK, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    expect(w.row("tab-1")?.state).toBe("running")
    // ESC: no hook fires; the engine rewrites its title to the resting form.
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "✳ 修复构建失败", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await waitFor(() => w.row("tab-1")?.state === "idle")
    // The rollup was owned by the same tab, so the task row settles too.
    expect(w.taskRollup()).toBeUndefined()
  })

  it("a frozen working title with silent output downgrades to idle", async () => {
    // A stale ⠹ frame must not pin running forever: title frozen AND output
    // silent for the whole window together mean not working.
    const w = world({ silenceMs: 60 })
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "⠹ add the ruler", totalBytes: 100 }]
    w.state.engines.set(42, "codex")
    await waitFor(() => w.row("tab-1")?.state === "running")
    await waitFor(() => w.row("tab-1")?.state === "idle")
  })

  it("advancing output keeps an engine WITHOUT title vocabulary running; silence retires it", async () => {
    const w = world({ silenceMs: 90 })
    const session: FakeSession = { key: KEY, alive: true, pid: 42, title: "my-agent", totalBytes: 100 }
    w.state.sessions = [session]
    w.state.engines.set(42, "someCustomEngine")
    // Idle at its prompt: no title verdict, no movement — must stay UNKNOWN
    // (no claim) rather than light a spinner.
    await wait(60)
    expect(w.row("tab-1")).toBeUndefined()
    // Output starts moving → running.
    session.totalBytes += 50
    await waitFor(() => w.row("tab-1")?.state === "running")
    // Output stops → idle after the silence window.
    await waitFor(() => w.row("tab-1")?.state === "idle")
  })

  it("a dead or vanished session retires its claim — and corrects a stale hook running", async () => {
    const w = world()
    w.registry.report(TASK, "turn-start", undefined, "tab-1", { id: "s1" }, "claude")
    w.state.sessions = [{ key: KEY, alive: false, pid: 42, title: "", totalBytes: 100 }]
    await waitFor(() => w.row("tab-1")?.state === "idle")
  })

  it("an unreachable pty host retires only OBSERVED claims — hook claims stand", async () => {
    const w = world()
    // Observer seeded running from observation…
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "⠂ working", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await waitFor(() => w.row("tab-1")?.state === "running")
    // …and a sibling tab holds a HOOK claim.
    w.registry.report(TASK, "turn-start", undefined, "tab-2", { id: "s2" }, "claude")
    w.state.sessions = null // host gone
    await waitFor(() => w.row("tab-1")?.state === "idle")
    expect(w.row("tab-2")?.state).toBe("running")
  })

  it("hook events outrank observation: a sticky badge is never overwritten", async () => {
    const w = world()
    w.registry.report(TASK, "awaiting-input", { waiting: "permission" }, "tab-1", { id: "s1" }, "claude")
    // The blocked engine writes nothing and its title rests — exactly the
    // state the old watchdog wrongly idled. The observer must not.
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "✳ waiting", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await wait(100)
    expect(w.row("tab-1")?.state).toBe("permission_needed")
  })

  it("split shell leaves (taskId::tabId::leaf-N keys) claim nothing", async () => {
    const w = world()
    w.state.sessions = [{ key: `${KEY}::leaf-2`, alive: true, pid: 42, title: "⠂ vim", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await wait(80)
    expect(w.row("tab-1")).toBeUndefined()
  })

  it("a KNOWN-idle marker replays to a late subscriber, distinguishable from unknown", async () => {
    const w = world({ silenceMs: 40 })
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "✳ resting", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await waitFor(() => w.row("tab-1")?.state === "idle")
    // Late subscriber: replay must carry the known-idle fact for tab-1 —
    // and nothing for tab-9, which stays unknown.
    const replay = w.registry.currentNonIdle()
    expect(replay.some((p) => p.tabId === "tab-1" && p.state === "idle")).toBe(true)
    expect(replay.some((p) => p.tabId === "tab-9")).toBe(false)
  })

  it("a tab-scoped idle never clears a rollup another tab owns", async () => {
    const w = world({ silenceMs: 40 })
    // tab-2 runs via hook; tab-1's quiet session goes known-idle.
    w.registry.report(TASK, "turn-start", undefined, "tab-2", { id: "s2" }, "claude")
    w.state.sessions = [{ key: KEY, alive: true, pid: 42, title: "✳ resting", totalBytes: 100 }]
    w.state.engines.set(42, "claude")
    await waitFor(() => w.row("tab-1")?.state === "idle")
    expect(w.taskRollup()?.state).toBe("running")
  })
})
