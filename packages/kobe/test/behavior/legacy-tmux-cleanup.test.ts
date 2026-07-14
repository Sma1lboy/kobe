import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { legacyPaneProcesses, parseLegacyPsRows, stopLegacyTmux } from "../../src/cli/legacy-tmux.ts"

const TMUX_AVAILABLE = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0
const SOCKET = `kobe-legacy-cleanup-${process.pid}`
const SESSION = "legacy-cleanup"
let panePgid: number | null = null

function tmux(...args: string[]) {
  return spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function groupProcesses(pgid: number) {
  const result = spawnSync("ps", ["-axo", "pid,pgid,rss,comm"], { encoding: "utf8" })
  return legacyPaneProcesses(parseLegacyPsRows(result.stdout ?? ""), [pgid])
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
}

beforeAll(() => {
  vi.stubGlobal("Bun", {
    spawn(argv: readonly string[]) {
      const child = spawn(argv[0] ?? "", argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
      return {
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        exited: new Promise<number>((resolve) => {
          child.once("error", () => resolve(127))
          child.once("close", (code) => resolve(code ?? 1))
        }),
      }
    },
  })
})

afterAll(() => {
  if (panePgid && panePgid > 1) {
    try {
      process.kill(-panePgid, "SIGKILL")
    } catch {
      // The regression path already cleaned it.
    }
  }
  tmux("kill-server")
  vi.unstubAllGlobals()
})

describe.skipIf(!TMUX_AVAILABLE)("legacy tmux process-group cleanup", () => {
  it("terminates a HUP-ignoring pane group before killing the server", async () => {
    const command = "/bin/sh -c 'trap \"\" HUP; while :; do sleep 1; done'"
    const created = tmux("new-session", "-d", "-s", SESSION, command)
    expect(created.status, created.stderr).toBe(0)

    const pane = tmux("list-panes", "-t", SESSION, "-F", "#{pane_pid}")
    panePgid = Number.parseInt(pane.stdout.trim(), 10)
    expect(panePgid).toBeGreaterThan(1)

    await waitUntil(() => groupProcesses(panePgid ?? 0).length >= 2, 5_000)
    const groupPids = groupProcesses(panePgid ?? 0).map((row) => row.pid)
    expect(groupPids.length).toBeGreaterThanOrEqual(2)

    await expect(stopLegacyTmux(SOCKET)).resolves.toMatchObject({
      status: "stopped",
      sessions: 1,
      signalledGroups: 1,
    })

    await waitUntil(() => groupPids.every((pid) => !isAlive(pid)), 10_000)
    expect(groupPids.filter(isAlive)).toEqual([])
    expect(tmux("list-sessions").status).not.toBe(0)
  }, 20_000)

  it("reports failure when a pane process group survives TERM and HUP", async () => {
    const command = "/bin/sh -c 'trap \"\" HUP TERM; while :; do sleep 1; done'"
    const created = tmux("new-session", "-d", "-s", "term-ignore", command)
    expect(created.status, created.stderr).toBe(0)

    const pane = tmux("list-panes", "-t", "term-ignore", "-F", "#{pane_pid}")
    panePgid = Number.parseInt(pane.stdout.trim(), 10)
    expect(panePgid).toBeGreaterThan(1)
    await waitUntil(() => groupProcesses(panePgid ?? 0).length >= 2, 5_000)

    await expect(stopLegacyTmux(SOCKET)).resolves.toMatchObject({
      status: "failed",
      sessions: 1,
      signalledGroups: 1,
      error: expect.stringContaining("pane process groups still alive"),
    })
    expect(groupProcesses(panePgid ?? 0).length).toBeGreaterThan(0)
    expect(tmux("list-sessions").status).not.toBe(0)

    process.kill(-(panePgid ?? 0), "SIGKILL")
    await waitUntil(() => groupProcesses(panePgid ?? 0).length === 0, 5_000)
    expect(groupProcesses(panePgid ?? 0)).toEqual([])
    panePgid = null
  }, 20_000)
})
