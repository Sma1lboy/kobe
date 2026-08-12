/**
 * `digest` tests — the ruler's arithmetic and its window/repo filtering.
 * Pins: routine runs bucket by status, and both sides drop anything older
 * than the window or belonging to another repo.
 */

import type { AutomationRun } from "@sma1lboy/kobe-daemon/daemon/contracts"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { buildDigest } from "../../src/cli/api/handlers-digest.ts"
import { FakeClient, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

const runtime = stubRuntime()

function run(status: AutomationRun["status"]): AutomationRun {
  return {
    id: `r-${status}`,
    automationId: "a1",
    runNumber: 1,
    scheduledFor: "2026-08-07T09:00:00.000Z",
    status,
    trigger: "scheduled",
    at: "2026-08-07T09:00:01.000Z",
  }
}

describe("buildDigest", () => {
  it("counts touched tasks", () => {
    const tasks = [
      taskFixture({ id: "t1" }) as unknown as SerializedTask,
      taskFixture({ id: "t2" }) as unknown as SerializedTask,
    ]
    expect(buildDigest("/repo/x", 0, tasks, []).tasks).toEqual({ total: 2 })
  })

  it("buckets routine runs by status and never invents statuses it did not see", () => {
    const d = buildDigest("/repo/x", 0, [], [run("dispatched"), run("dispatched"), run("skipped_precheck")])
    expect(d.routines).toEqual({ runs: 3, byStatus: { dispatched: 2, skipped_precheck: 1 } })
  })
})

describe("digest handler", () => {
  const inWindow = new Date(Date.now() - 3600_000).toISOString()
  const outOfWindow = new Date(Date.now() - 30 * 86_400_000).toISOString()

  it("drops tasks outside the window, other repos, and non-card seats", async () => {
    const client = new FakeClient({
      "task.list": () => ({
        tasks: [
          taskFixture({ id: "fresh", repo: "/repo/x", updatedAt: inWindow }),
          taskFixture({ id: "stale", repo: "/repo/x", updatedAt: outOfWindow }),
          taskFixture({ id: "other", repo: "/repo/y", updatedAt: inWindow }),
          // The dispatcher seat is not a unit of work — counting it would
          // park a permanent +1 in the total.
          taskFixture({ id: "main", kind: "main", repo: "/repo/x", updatedAt: inWindow }),
        ],
      }),
      "automation.list": () => ({ automations: [] }),
    })
    const result = (await invokeVerb("digest", ["--repo", "/repo/x"], { client, runtime })) as {
      tasks: { total: number }
    }
    expect(result.tasks.total).toBe(1)
  })

  it("pulls runs only from this repo's routines and only inside the window", async () => {
    const client = new FakeClient({
      "task.list": () => ({ tasks: [] }),
      "automation.list": () => ({
        automations: [
          { id: "mine", repo: "/repo/x" },
          { id: "theirs", repo: "/repo/y" },
        ],
      }),
      "automation.runs": (payload) => {
        const id = (payload as { id: string }).id
        if (id === "theirs") return { runs: [{ ...run("dispatched"), at: inWindow }] }
        return {
          runs: [
            { ...run("dispatched"), at: inWindow },
            { ...run("dispatch_failed"), at: outOfWindow },
          ],
        }
      },
    })
    const result = (await invokeVerb("digest", ["--repo", "/repo/x"], { client, runtime })) as {
      routines: { runs: number; byStatus: Record<string, number> }
    }
    expect(result.routines).toEqual({ runs: 1, byStatus: { dispatched: 1 } })
  })
})
