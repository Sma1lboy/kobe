/**
 * keybindings channel — daemon → client round-trip (KOB — live keybinding
 * propagation). The watcher unit test exercises the file→bus half in
 * isolation; this one wires the WHOLE pipe a pane actually uses: a real
 * daemon server (which starts the keybindings watcher from its homeDir) →
 * the Unix socket → a `KobeDaemonClient` subscribed to the `keybindings`
 * channel. It pins the two things inspection can't: the server actually
 * installs the watcher, and a file edit reaches a subscriber as a rev bump.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  expect(cond()).toBe(true)
}

describe("keybindings channel (daemon → client round-trip)", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let kbFile: string
  let server: DaemonServer | null
  let savedHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-kb-chan-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
    const settingsDir = join(dir, ".kobe", "settings")
    kbFile = join(settingsDir, "keybindings.yaml")
    mkdirSync(settingsDir, { recursive: true })
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

  it("delivers an initial rev, then bumps it when keybindings.yaml changes", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 25,
    })

    const client = new KobeDaemonClient(socketPath)
    const revs: number[] = []
    client.onChannel("keybindings", (payload) => revs.push(payload.rev))
    await client.subscribe()

    // The watcher's start-time publish seeds the bus last-value, so the
    // subscribe replay hands the late client the current rev.
    await waitFor(() => revs.length >= 1)
    expect(revs[0]).toBe(0)

    // A real file edit → watcher bumps → the subscribed client sees it.
    writeFileSync(kbFile, "bindings:\n  sidebar.rename: ctrl+r\n", "utf8")
    await waitFor(() => revs.length >= 2)
    expect(revs.at(-1)).toBe(1)

    client.close()
  })
})
