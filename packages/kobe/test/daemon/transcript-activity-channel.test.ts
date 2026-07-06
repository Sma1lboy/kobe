import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Orchestrator } from "../../src/orchestrator/core.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function fakeOrchestrator(worktreePath: string): Orchestrator {
  const task: Task = {
    id: toTaskId("t1"),
    title: "t1",
    repo: "/repo",
    branch: "t1",
    worktreePath,
    vendor: "claude",
    status: "backlog",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task
  return {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([task])
      return () => {}
    },
    listTasks: () => [task],
  } as unknown as Orchestrator
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("transcript.activity channel (daemon → client)", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let server: DaemonServer | null
  let savedHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-ta-chan-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
    savedHome = process.env.KOBE_HOME_DIR
    process.env.KOBE_HOME_DIR = dir
    server = null
  })

  afterEach(async () => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    else process.env.KOBE_HOME_DIR = savedHome
    await server?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  it("advertises transcript.activity in hello.capabilities", async () => {
    server = await startDaemonServer(fakeOrchestrator(dir), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      prStatusPollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 0,
      worktreeChangesTickMs: 0,
      transcriptActivityTickMs: 0,
    })

    const client = new KobeDaemonClient(socketPath)
    const hello = await client.request<{ capabilities?: string[] }>("hello", {})
    expect(hello.capabilities).toContain("transcript.activity")
    client.close()
  })

  it("replays the collector's last value to a late subscriber", async () => {
    server = await startDaemonServer(fakeOrchestrator(dir), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      prStatusPollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 0,
      worktreeChangesTickMs: 0,
      transcriptActivityTickMs: 25,
    })

    const first = new KobeDaemonClient(socketPath)
    let firstPayload: { activity?: Record<string, unknown> } | undefined
    first.on("transcript.activity", (frame) => {
      firstPayload = frame.payload as { activity?: Record<string, unknown> }
    })
    await first.subscribe({ role: "gui" })
    await waitFor(() => firstPayload?.activity?.[dir] !== undefined)
    expect(firstPayload?.activity?.[dir]).toEqual({ mtimeMs: 0, completionId: null, completionAt: 0 })

    const late = new KobeDaemonClient(socketPath)
    let latePayload: { activity?: Record<string, unknown> } | undefined
    late.on("transcript.activity", (frame) => {
      latePayload = frame.payload as { activity?: Record<string, unknown> }
    })
    await late.subscribe({ role: "pane" })
    await waitFor(() => latePayload?.activity?.[dir] !== undefined)
    expect(latePayload?.activity?.[dir]).toEqual({ mtimeMs: 0, completionId: null, completionAt: 0 })

    first.close()
    late.close()
  })

  it("publishes nothing until a subscriber exists (hasSubscribers gate)", async () => {
    server = await startDaemonServer(fakeOrchestrator(dir), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      prStatusPollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 0,
      worktreeChangesTickMs: 0,
      transcriptActivityTickMs: 25,
    })

    await new Promise((r) => setTimeout(r, 150))

    const client = new KobeDaemonClient(socketPath)
    let payload: { activity?: Record<string, unknown> } | undefined
    client.on("transcript.activity", (frame) => {
      payload = frame.payload as { activity?: Record<string, unknown> }
    })
    await client.subscribe({ role: "gui" })
    await waitFor(() => payload?.activity?.[dir] !== undefined)
    expect(payload?.activity?.[dir]).toEqual({ mtimeMs: 0, completionId: null, completionAt: 0 })
    client.close()
  })
})
