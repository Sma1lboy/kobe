import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AutomationsStore, pruneRuns } from "../../../kobe-daemon/src/daemon/automations-store.ts"
import type { AutomationRun } from "../../../kobe-daemon/src/daemon/contracts.ts"

const NOW = new Date(2026, 6, 31, 10, 0, 0).getTime() // 2026-07-31 10:00 local

function tempStore(now = () => NOW): { store: AutomationsStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kobe-automations-"))
  const path = join(dir, "automations.json")
  return { store: new AutomationsStore(path, now), path }
}

const BASE = {
  name: "audit",
  repo: "/repo",
  prompt: "run the audit",
  schedule: "0 9 * * *",
  missedRunGraceMinutes: 60,
}

describe("AutomationsStore", () => {
  let store: AutomationsStore | null = null

  afterEach(() => {
    store = null
  })

  it("computes nextRunAt from the schedule on create", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create(BASE)
    // 10:00 now, daily 09:00 → tomorrow.
    expect(new Date(created.nextRunAt).getDate()).toBe(1)
    expect(new Date(created.nextRunAt).getHours()).toBe(9)
  })

  it("rejects a schedule that parses but never fires", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    await expect(store.create({ ...BASE, schedule: "0 0 30 2 *" })).rejects.toThrow(/never matches/)
  })

  it("survives a restart by reloading from disk", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create(BASE)

    // A second store over the same path is exactly what a daemon restart is.
    const reborn = new AutomationsStore(t.path, () => NOW)
    await reborn.init()
    expect(reborn.list()).toHaveLength(1)
    expect(reborn.get(created.id)?.nextRunAt).toBe(created.nextRunAt)
  })

  it("writes atomically and leaves valid JSON on disk", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    await store.create(BASE)
    const parsed = JSON.parse(readFileSync(t.path, "utf8"))
    expect(parsed.version).toBe(1)
    expect(parsed.automations).toHaveLength(1)
  })

  it("starts empty on a corrupt file instead of throwing", async () => {
    const t = tempStore()
    writeFileSync(t.path, "{ not json")
    store = t.store
    // Must not reject — a bad automations file cannot block daemon boot.
    await store.init()
    expect(store.list()).toEqual([])
  })

  it("drops malformed records but keeps the good ones", async () => {
    const t = tempStore()
    writeFileSync(
      t.path,
      JSON.stringify({
        version: 1,
        automations: [
          {
            id: "keep",
            name: "n",
            repo: "/r",
            prompt: "p",
            schedule: "0 9 * * *",
            nextRunAt: "2026-08-01T09:00:00.000Z",
          },
          { id: "no-schedule", name: "n", repo: "/r", prompt: "p" },
          { id: "bad-date", name: "n", repo: "/r", prompt: "p", schedule: "0 9 * * *", nextRunAt: "not-a-date" },
          null,
        ],
        runs: [],
      }),
    )
    store = t.store
    await store.init()
    expect(store.list().map((a) => a.id)).toEqual(["keep"])
  })

  it("re-anchors nextRunAt when the schedule changes", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create(BASE)
    const updated = await store.update(created.id, { schedule: "*/15 * * * *" })
    expect(updated?.nextRunAt).not.toBe(created.nextRunAt)
    expect(new Date(updated?.nextRunAt ?? 0).getMinutes()).toBe(15)
  })

  it("leaves nextRunAt alone for non-schedule edits", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create(BASE)
    const updated = await store.update(created.id, { name: "renamed" })
    expect(updated?.nextRunAt).toBe(created.nextRunAt)
    expect(updated?.name).toBe("renamed")
  })

  it("clears precheck when patched with null", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create({ ...BASE, precheck: { command: "true", timeoutSeconds: 30 } })
    expect(created.precheck).toBeDefined()
    const updated = await store.update(created.id, { precheck: null })
    expect(updated?.precheck).toBeUndefined()
  })

  it("advances nextRunAt strictly past the fire time", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const created = await store.create({ ...BASE, schedule: "*/15 * * * *" })
    const fired = Date.parse(created.nextRunAt)
    const advanced = await store.advanceNextRun(created.id, fired)
    // Strictly-after, or the sweep would re-fire the same occurrence forever.
    expect(Date.parse(advanced?.nextRunAt ?? "")).toBeGreaterThan(fired)
    expect(advanced?.lastRunAt).toBe(new Date(fired).toISOString())
  })

  it("disables an automation whose stored schedule can no longer resolve", async () => {
    const t = tempStore()
    // Hand-edited file with a schedule that parses but never fires. Left
    // enabled it would stay permanently due and spin the sweep every tick.
    writeFileSync(
      t.path,
      JSON.stringify({
        version: 1,
        automations: [
          {
            id: "stuck",
            name: "n",
            repo: "/r",
            prompt: "p",
            schedule: "0 0 30 2 *",
            nextRunAt: "2026-01-01T00:00:00.000Z",
            enabled: true,
          },
        ],
        runs: [],
      }),
    )
    store = t.store
    await store.init()
    const advanced = await store.advanceNextRun("stuck", NOW)
    expect(advanced?.enabled).toBe(false)
  })

  it("numbers runs monotonically and keeps numbering past a prune", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const a = await store.create(BASE)
    const first = await store.recordRun({
      automationId: a.id,
      scheduledFor: new Date(NOW).toISOString(),
      status: "dispatched",
      trigger: "scheduled",
      at: new Date(NOW).toISOString(),
    })
    const second = await store.recordRun({
      automationId: a.id,
      scheduledFor: new Date(NOW).toISOString(),
      status: "skipped_precheck",
      trigger: "scheduled",
      at: new Date(NOW + 1000).toISOString(),
    })
    expect(first.runNumber).toBe(1)
    expect(second.runNumber).toBe(2)
    expect(store.runsFor(a.id).map((r) => r.runNumber)).toEqual([2, 1])
  })

  it("drops an automation's runs along with the automation", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    const a = await store.create(BASE)
    await store.recordRun({
      automationId: a.id,
      scheduledFor: new Date(NOW).toISOString(),
      status: "dispatched",
      trigger: "manual",
      at: new Date(NOW).toISOString(),
    })
    expect(await store.delete(a.id)).toBe(true)
    expect(store.runsFor(a.id)).toEqual([])
    expect(JSON.parse(readFileSync(t.path, "utf8")).runs).toEqual([])
  })

  it("reports whether any enabled automation exists (the keep-alive gate)", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    expect(store.hasEnabled()).toBe(false)
    const a = await store.create(BASE)
    expect(store.hasEnabled()).toBe(true)
    await store.update(a.id, { enabled: false })
    expect(store.hasEnabled()).toBe(false)
  })

  it("serializes concurrent mutations without losing any", async () => {
    const t = tempStore()
    store = t.store
    await store.init()
    await Promise.all([
      store.create({ ...BASE, name: "a" }),
      store.create({ ...BASE, name: "b" }),
      store.create({ ...BASE, name: "c" }),
    ])
    expect(store.list()).toHaveLength(3)
    expect(JSON.parse(readFileSync(t.path, "utf8")).automations).toHaveLength(3)
  })
})

describe("pruneRuns", () => {
  function run(id: string, automationId: string, atMs: number, runNumber: number): AutomationRun {
    return {
      id,
      automationId,
      runNumber,
      scheduledFor: new Date(atMs).toISOString(),
      status: "dispatched",
      trigger: "scheduled",
      at: new Date(atMs).toISOString(),
    }
  }

  it("keeps the newest N per automation", () => {
    const runs = [run("r1", "a", NOW, 1), run("r2", "a", NOW + 1, 2), run("r3", "a", NOW + 2, 3)]
    expect(pruneRuns(runs, new Set(), 2).map((r) => r.id)).toEqual(["r2", "r3"])
  })

  it("counts per automation, not globally", () => {
    const runs = [run("a1", "a", NOW, 1), run("b1", "b", NOW, 1), run("a2", "a", NOW + 1, 2)]
    expect(pruneRuns(runs, new Set(), 1).map((r) => r.id)).toEqual(["b1", "a2"])
  })

  it("drops runs only for automations named as deleted", () => {
    const runs = [run("a1", "a", NOW, 1), run("ghost", "deleted", NOW, 1)]
    expect(pruneRuns(runs, new Set(["deleted"])).map((r) => r.id)).toEqual(["a1"])
  })

  it("keeps runs whose automation id it does not recognize", () => {
    // Retention must never be the reason a legitimate run disappears — an
    // unknown id is not evidence of garbage.
    const runs = [run("a1", "a", NOW, 1), run("unknown", "not-in-store", NOW, 1)]
    expect(pruneRuns(runs).map((r) => r.id)).toEqual(["a1", "unknown"])
  })

  it("preserves append order among survivors", () => {
    const runs = [run("r1", "a", NOW + 5, 1), run("r2", "a", NOW, 2), run("r3", "a", NOW + 9, 3)]
    expect(pruneRuns(runs, new Set(), 3).map((r) => r.id)).toEqual(["r1", "r2", "r3"])
  })
})
