import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TaskActivityState } from "../../src/engine/hook-events.ts"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

const TTL_MS = 30

function fakeOrchestrator(): Orchestrator {
  return {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([])
      return () => {}
    },
    listTasks: () => [],
  } as unknown as Orchestrator
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("daemon activity state", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let server: DaemonServer | null
  let prevTtl: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-activity-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
    prevTtl = process.env.KOBE_ENGINE_STATE_TTL_MS
    process.env.KOBE_ENGINE_STATE_TTL_MS = String(TTL_MS)
    server = null
  })

  afterEach(async () => {
    if (prevTtl === undefined) Reflect.deleteProperty(process.env, "KOBE_ENGINE_STATE_TTL_MS")
    else process.env.KOBE_ENGINE_STATE_TTL_MS = prevTtl
    await server?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps turn-complete visible instead of lapsing it back to idle", async () => {
    server = await startDaemonServer(fakeOrchestrator(), { socketPath, pidPath, updatePollMs: 0 })
    const client = new KobeDaemonClient(socketPath)
    const states: TaskActivityState[] = []
    client.onChannel("engine-state", (payload) => {
      if (payload.taskId === "task-1") states.push(payload.state)
    })
    await client.subscribe()

    await client.request("engine.reportEvent", { taskId: "task-1", kind: "turn-complete" })
    await sleep(TTL_MS + 50)

    expect(states).toEqual(["turn_complete"])
    client.close()
  })
})
