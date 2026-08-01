import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { DaemonRpcClient } from "../../../kobe-daemon/src/client/rpc.ts"
import {
  dueAutomations,
  resolveDueOccurrence,
  runAutomationOnce,
  startAutomationRunner,
  sweepAutomations,
} from "../../../kobe-daemon/src/daemon/automation-runner.ts"
import { AutomationsStore } from "../../../kobe-daemon/src/daemon/automations-store.ts"
import type { Automation, DaemonTask } from "../../../kobe-daemon/src/daemon/contracts.ts"

const NOW = new Date(2026, 6, 31, 10, 0, 0).getTime() // Fri 2026-07-31 10:00 local
const HOUR = 3_600_000
/** A real directory: prechecks spawn with `cwd: automation.repo`. */
const REPO = process.cwd()

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "audit",
    repo: REPO,
    prompt: "run the audit",
    schedule: "0 9 * * *",
    enabled: true,
    nextRunAt: new Date(NOW).toISOString(),
    missedRunGraceMinutes: 60,
    createdAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
    ...overrides,
  }
}

async function tempStore(now = () => NOW): Promise<AutomationsStore> {
  const dir = mkdtempSync(join(tmpdir(), "kobe-automation-runner-"))
  const store = new AutomationsStore(join(dir, "automations.json"), now)
  await store.init()
  return store
}

const link = {} as DaemonRpcClient

function fakeDeps(args: {
  store: AutomationsStore
  createTask?: (input: unknown) => Promise<DaemonTask>
  start?: (link: DaemonRpcClient, taskId: string, prompt: string) => Promise<boolean>
}) {
  const created: unknown[] = []
  const prompts: string[] = []
  return {
    created,
    prompts,
    deps: {
      store: args.store,
      orch: {
        createTask:
          args.createTask ??
          (async (input: unknown) => {
            created.push(input)
            return { id: "task-1" } as DaemonTask
          }),
      },
      runtime: {
        startTaskSessionWithPrompt:
          args.start ??
          (async (_l: DaemonRpcClient, _id: string, prompt: string) => {
            prompts.push(prompt)
            return true
          }),
      },
      link,
      now: () => NOW,
    },
  }
}

describe("dueAutomations", () => {
  it("selects only enabled schedules whose time has arrived", () => {
    const list = [
      automation({ id: "due" }),
      automation({ id: "future", nextRunAt: new Date(NOW + HOUR).toISOString() }),
      automation({ id: "disabled", enabled: false }),
      automation({ id: "bad-date", nextRunAt: "not-a-date" }),
    ]
    expect(dueAutomations(list, NOW).map((a) => a.id)).toEqual(["due"])
  })
})

describe("resolveDueOccurrence", () => {
  it("reports the occurrence that should have run, not the current time", () => {
    // Fired at 10:00 for a 09:00 daily schedule.
    const found = resolveDueOccurrence(automation(), NOW)
    expect(new Date(found?.scheduledFor ?? 0).getHours()).toBe(9)
  })

  it("marks an occurrence inside the grace window as runnable", () => {
    // 10:00 now, 09:00 scheduled, 60m grace → exactly at the edge, still fine.
    expect(resolveDueOccurrence(automation(), NOW)?.missed).toBe(false)
  })

  it("marks an occurrence past the grace window as missed", () => {
    const found = resolveDueOccurrence(automation({ missedRunGraceMinutes: 30 }), NOW)
    expect(found?.missed).toBe(true)
  })

  it("will not claim occurrences from before the automation existed", () => {
    // Created at 09:30, so today's 09:00 is not its occurrence.
    const fresh = automation({ createdAt: new Date(NOW - 30 * 60_000).toISOString() })
    expect(resolveDueOccurrence(fresh, NOW)).toBeNull()
  })

  it("returns the single most recent occurrence after a long outage", () => {
    // Daemon down for three days: the answer is yesterday's 09:00 (one run),
    // never a stampede of every missed day.
    const found = resolveDueOccurrence(automation(), NOW + 3 * 24 * HOUR)
    expect(found?.scheduledFor).toBe(new Date(2026, 7, 3, 9, 0).getTime())
  })
})

describe("runAutomationOnce", () => {
  it("creates a task and starts its engine with the prompt", async () => {
    const store = await tempStore()
    const { deps, created, prompts } = fakeDeps({ store })
    const a = automation()

    const status = await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "scheduled" })

    expect(status).toBe("dispatched")
    expect(created).toEqual([{ repo: REPO, title: "audit" }])
    expect(prompts).toEqual(["run the audit"])
    expect(store.runsFor(a.id)[0]).toMatchObject({ status: "dispatched", taskId: "task-1" })
  })

  it("passes vendor and baseRef through to task creation", async () => {
    const store = await tempStore()
    const { deps, created } = fakeDeps({ store })
    await runAutomationOnce(deps, automation({ vendor: "codex", baseRef: "develop" }), {
      scheduledFor: NOW,
      trigger: "scheduled",
    })
    expect(created[0]).toMatchObject({ vendor: "codex", baseRef: "develop" })
  })

  it("skips without creating a task when the precheck fails", async () => {
    const store = await tempStore()
    const { deps, created } = fakeDeps({ store })
    const a = automation({ precheck: { command: "exit 1", timeoutSeconds: 10 } })

    const status = await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "scheduled" })

    expect(status).toBe("skipped_precheck")
    // The whole point of a precheck: no engine, no token spend.
    expect(created).toEqual([])
    expect(store.runsFor(a.id)[0]?.precheckResult?.exitCode).toBe(1)
  })

  it("proceeds when the precheck exits zero", async () => {
    const store = await tempStore()
    const { deps, created } = fakeDeps({ store })
    const a = automation({ precheck: { command: "exit 0", timeoutSeconds: 10 } })

    expect(await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "scheduled" })).toBe("dispatched")
    expect(created).toHaveLength(1)
  })

  it("ignores the precheck on a manual trigger", async () => {
    const store = await tempStore()
    const { deps, created } = fakeDeps({ store })
    // Asking for it by hand IS the answer to "is this worth running".
    const a = automation({ precheck: { command: "exit 1", timeoutSeconds: 10 } })

    expect(await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "manual" })).toBe("dispatched")
    expect(created).toHaveLength(1)
  })

  it("records skipped_unavailable when the repo is gone", async () => {
    const store = await tempStore()
    const { deps } = fakeDeps({
      store,
      createTask: async () => {
        throw new Error("repo not found")
      },
    })
    const a = automation()

    expect(await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "scheduled" })).toBe("skipped_unavailable")
    expect(store.runsFor(a.id)[0]?.error).toMatch(/repo not found/)
  })

  it("records dispatch_failed but keeps the task id when the engine will not start", async () => {
    const store = await tempStore()
    const { deps } = fakeDeps({ store, start: async () => false })
    const a = automation()

    expect(await runAutomationOnce(deps, a, { scheduledFor: NOW, trigger: "scheduled" })).toBe("dispatch_failed")
    // The task exists; surfacing its id lets the user open and retry it.
    expect(store.runsFor(a.id)[0]).toMatchObject({ status: "dispatch_failed", taskId: "task-1" })
  })
})

describe("sweepAutomations", () => {
  it("advances the schedule past the fired occurrence", async () => {
    const store = await tempStore()
    const created = await store.create({
      name: "audit",
      repo: REPO,
      prompt: "p",
      schedule: "*/15 * * * *",
      missedRunGraceMinutes: 60,
    })
    const { deps } = fakeDeps({ store })
    // Force it due.
    await store.advanceNextRun(created.id, NOW - 60_000)

    await sweepAutomations(deps)

    expect(Date.parse(store.get(created.id)?.nextRunAt ?? "")).toBeGreaterThan(NOW)
  })

  it("does not fire the same occurrence twice across overlapping sweeps", async () => {
    const store = await tempStore()
    const created = await store.create({
      name: "audit",
      repo: REPO,
      prompt: "p",
      schedule: "*/15 * * * *",
      missedRunGraceMinutes: 60,
    })
    const { deps, prompts } = fakeDeps({ store })
    await store.advanceNextRun(created.id, NOW - 60_000)

    await sweepAutomations(deps)
    await sweepAutomations(deps)

    expect(prompts).toHaveLength(1)
  })

  it("records skipped_missed without dispatching when past the grace window", async () => {
    // The daemon was down when 09:00 came around and only came back at 10:00,
    // outside the 30m grace. Arming a schedule whose nextRunAt is already in
    // the past is exactly what a persisted file looks like after an outage.
    const dir = mkdtempSync(join(tmpdir(), "kobe-automation-missed-"))
    const path = join(dir, "automations.json")
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        automations: [
          {
            id: "missed",
            name: "audit",
            repo: REPO,
            prompt: "p",
            schedule: "0 9 * * *",
            enabled: true,
            nextRunAt: new Date(NOW - HOUR).toISOString(),
            missedRunGraceMinutes: 30,
            createdAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
            updatedAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
          },
        ],
        runs: [],
      }),
    )
    const store = new AutomationsStore(path, () => NOW)
    await store.init()
    const { deps, created: tasks } = fakeDeps({ store })

    await sweepAutomations(deps)

    expect(tasks).toEqual([])
    expect(store.runsFor("missed")[0]?.status).toBe("skipped_missed")
    // And the schedule still moved on, so the stale occurrence cannot re-fire.
    expect(Date.parse(store.get("missed")?.nextRunAt ?? "")).toBeGreaterThan(NOW)
  })

  it("picks up a schedule armed by a previous daemon (restart survival)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-automation-restart-"))
    const path = join(dir, "automations.json")

    // Daemon #1 arms a schedule, then dies.
    const first = new AutomationsStore(path, () => NOW - HOUR)
    await first.init()
    const created = await first.create({
      name: "audit",
      repo: REPO,
      prompt: "p",
      schedule: "*/15 * * * *",
      missedRunGraceMinutes: 60,
    })

    // Daemon #2 boots fresh with no in-memory timers whatsoever.
    const second = new AutomationsStore(path, () => NOW)
    await second.init()
    const { deps, prompts } = fakeDeps({ store: second })

    await sweepAutomations(deps)

    // Fired purely off the persisted nextRunAt — no re-arm pass exists.
    expect(prompts).toEqual(["p"])
    expect(second.get(created.id)).toBeDefined()
  })
})

describe("startAutomationRunner", () => {
  it("is disabled by a zero tick (the test harness contract)", async () => {
    const store = await tempStore()
    const { deps } = fakeDeps({ store })
    const spy = vi.spyOn(store, "list")
    const stop = startAutomationRunner(deps, 0)
    stop()
    expect(spy).not.toHaveBeenCalled()
  })

  it("stops cleanly", async () => {
    const store = await tempStore()
    const { deps } = fakeDeps({ store })
    const stop = startAutomationRunner(deps, 60_000)
    expect(() => stop()).not.toThrow()
  })
})
