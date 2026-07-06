import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

function fakeOrchestrator(): Orchestrator {
  return {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([])
      return () => {}
    },
    listTasks: () => [],
  } as unknown as Orchestrator
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("per-channel subscribe filter (daemon → client)", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let server: DaemonServer | null
  let savedHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-chan-filter-"))
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

  it("a filtered subscriber receives only its channels in the replay", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 25,
      worktreeChangesTickMs: 0,
    })

    const client = new KobeDaemonClient(socketPath)
    const channels: string[] = []
    client.on("*", (frame) => {
      if (frame.name !== "daemon.stopping") channels.push(frame.name)
    })
    await client.subscribe({ channels: ["keybindings"] })

    await waitFor(() => channels.includes("keybindings"))
    expect(channels).toContain("keybindings")
    expect(channels).not.toContain("task.snapshot")

    client.close()
  })

  it("an unfiltered subscriber still receives every channel (back-compat)", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 25,
      worktreeChangesTickMs: 0,
    })

    const client = new KobeDaemonClient(socketPath)
    const channels: string[] = []
    client.on("*", (frame) => {
      if (frame.name !== "daemon.stopping") channels.push(frame.name)
    })
    await client.subscribe()

    await waitFor(() => channels.includes("task.snapshot") && channels.includes("keybindings"))
    expect(channels).toContain("task.snapshot")
    expect(channels).toContain("keybindings")

    client.close()
  })
})
