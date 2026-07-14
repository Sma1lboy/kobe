import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inspectLegacyTmux,
  legacyPaneProcesses,
  legacyTmuxDoctorLines,
  parseLegacyPsRows,
  stopLegacyTmux,
} from "../../src/cli/legacy-tmux.ts"

function result(stdout = "", code = 0, stderr = "") {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(code),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("legacy tmux process inspection", () => {
  it("parses ps rows and selects complete pane process groups", () => {
    const rows = parseLegacyPsRows(
      ["PID PGID RSS COMM", "501 501 3168 bun", "510 501 9000 claude", "1 1 999 launchd"].join("\n"),
    )

    expect(rows).toEqual([
      { pid: 501, pgid: 501, rssKb: 3168, command: "bun" },
      { pid: 510, pgid: 501, rssKb: 9000, command: "claude" },
      { pid: 1, pgid: 1, rssKb: 999, command: "launchd" },
    ])
    expect(legacyPaneProcesses(rows, [501])).toEqual(rows.slice(0, 2))
  })

  it("reports an unavailable tmux binary without failing", async () => {
    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" })
      }),
    })

    await expect(inspectLegacyTmux()).resolves.toEqual({
      available: false,
      version: null,
      sessions: [],
      panePids: [],
      processes: [],
      error: null,
    })
  })

  it("keeps the installed version when no legacy server is running", async () => {
    vi.stubGlobal("Bun", {
      spawn: vi.fn((argv: readonly string[]) =>
        argv.join(" ") === "tmux -V" ? result("tmux 3.6b\n") : result("", 1, "no server running on /tmp/tmux/test"),
      ),
    })

    await expect(inspectLegacyTmux()).resolves.toEqual({
      available: true,
      version: "tmux 3.6b",
      sessions: [],
      panePids: [],
      processes: [],
      error: null,
    })
  })

  it("surfaces list-sessions failures instead of reporting zero sessions", async () => {
    vi.stubGlobal("Bun", {
      spawn: vi.fn((argv: readonly string[]) =>
        argv.join(" ") === "tmux -V" ? result("tmux 3.6b\n") : result("", 1, "permission denied"),
      ),
    })

    const report = await inspectLegacyTmux()
    expect(report.sessions).toEqual([])
    expect(report.error).toContain("tmux list-sessions failed: permission denied")
    expect(legacyTmuxDoctorLines(report)[0]).toContain("inspection failed")
  })

  it("formats version, session count, and RSS grouped by command", () => {
    const lines = legacyTmuxDoctorLines({
      available: true,
      version: "tmux 3.6b",
      sessions: ["kobe-a", "kobe-b"],
      panePids: [501, 502],
      processes: [
        { pid: 501, pgid: 501, rssKb: 4096, command: "bun" },
        { pid: 510, pgid: 501, rssKb: 2048, command: "bun" },
        { pid: 502, pgid: 502, rssKb: 3072, command: "claude" },
      ],
      error: null,
    })

    expect(lines[0]).toContain("tmux 3.6b — 2 pre-v0.8 session(s)")
    expect(lines[1]).toContain("3 process(es) across 2 pane(s), 9.0 MB RSS total")
    expect(lines).toContain("             bun: 2 proc, 6.0 MB")
    expect(lines).toContain("             claude: 1 proc, 3.0 MB")
    expect(lines.at(-1)).toContain("kobe reset")
  })
})

describe("stopLegacyTmux", () => {
  it("SIGTERMs pane process groups before killing the legacy server", async () => {
    const events: string[] = []
    const spawn = vi.fn((argv: readonly string[]) => {
      events.push(argv.join(" "))
      const command = argv.join(" ")
      if (command === "tmux -V") return result("tmux 3.6b\n")
      if (command.includes("list-sessions")) return result("kobe-a\nkobe-b\n")
      if (command.includes("list-panes")) return result("501\n502\n")
      if (command === "ps -axo pid,pgid,rss,comm") {
        return result("PID PGID RSS COMM\n501 501 1024 bun\n502 502 1024 bun\n")
      }
      if (command.startsWith("ps -o pgid=")) return result("502\n")
      if (command.endsWith("kill-server")) return result()
      throw new Error(`unexpected command: ${command}`)
    })
    vi.stubGlobal("Bun", { spawn })
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      events.push(`SIGTERM ${pid}`)
      return true
    })

    await expect(stopLegacyTmux("test-socket")).resolves.toEqual({
      status: "stopped",
      sessions: 2,
      signalledGroups: 1,
    })
    expect(kill).toHaveBeenCalledWith(-501, "SIGTERM")
    expect(kill).not.toHaveBeenCalledWith(-502, "SIGTERM")
    expect(events.indexOf("SIGTERM -501")).toBeLessThan(events.indexOf("tmux -L test-socket kill-server"))
  })

  it("refuses HUP-only cleanup when pane enumeration fails", async () => {
    const spawn = vi.fn((argv: readonly string[]) => {
      const command = argv.join(" ")
      if (command === "tmux -V") return result("tmux 3.6b\n")
      if (command.includes("list-sessions")) return result("kobe-a\n")
      if (command.includes("list-panes")) return result("", 1, "permission denied")
      throw new Error(`unexpected command: ${command}`)
    })
    vi.stubGlobal("Bun", { spawn })
    const kill = vi.spyOn(process, "kill")

    await expect(stopLegacyTmux("test-socket")).resolves.toMatchObject({
      status: "failed",
      error: "tmux list-panes failed: permission denied",
    })
    expect(kill).not.toHaveBeenCalled()
    expect(spawn.mock.calls.some(([argv]) => (argv as readonly string[]).includes("kill-server"))).toBe(false)
  })

  it("fails instead of swallowing a process-group permission error", async () => {
    const spawn = vi.fn((argv: readonly string[]) => {
      const command = argv.join(" ")
      if (command === "tmux -V") return result("tmux 3.6b\n")
      if (command.includes("list-sessions")) return result("kobe-a\n")
      if (command.includes("list-panes")) return result("501\n")
      if (command === "ps -axo pid,pgid,rss,comm") return result("PID PGID RSS COMM\n501 501 1024 bun\n")
      if (command.startsWith("ps -o pgid=")) return result("999\n")
      throw new Error(`unexpected command: ${command}`)
    })
    vi.stubGlobal("Bun", { spawn })
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" })
    })

    await expect(stopLegacyTmux("test-socket")).resolves.toMatchObject({
      status: "failed",
      error: "failed to SIGTERM pane group 501: not permitted",
    })
    expect(spawn.mock.calls.some(([argv]) => (argv as readonly string[]).includes("kill-server"))).toBe(false)
  })

  it("reports kill-server failure while the legacy server remains live", async () => {
    let listCalls = 0
    const spawn = vi.fn((argv: readonly string[]) => {
      const command = argv.join(" ")
      if (command === "tmux -V") return result("tmux 3.6b\n")
      if (command.includes("list-sessions")) {
        listCalls++
        return result("kobe-a\n")
      }
      if (command.includes("list-panes")) return result("501\n")
      if (command === "ps -axo pid,pgid,rss,comm") return result("PID PGID RSS COMM\n501 501 1024 bun\n")
      if (command.startsWith("ps -o pgid=")) return result("999\n")
      if (command.endsWith("kill-server")) return result("", 1, "permission denied")
      throw new Error(`unexpected command: ${command}`)
    })
    vi.stubGlobal("Bun", { spawn })
    vi.spyOn(process, "kill").mockReturnValue(true)

    await expect(stopLegacyTmux("test-socket")).resolves.toMatchObject({
      status: "failed",
      error: "permission denied",
    })
    expect(listCalls).toBe(2)
  })
})
