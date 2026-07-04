/**
 * `kobe doctor` resource section — pure halves (ps-output parsing +
 * pane-group filtering) plus the async wiring (`resourceDoctorLines`)
 * against a mocked tmux + `ps`. Why this matters: #205's memory reports had
 * no hard numbers to triage from; this is what kobe uses to build them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  tmuxAvailable: vi.fn(),
  runTmuxCapturing: vi.fn(),
  bunSpawn: vi.fn(),
}))

vi.mock("../../src/tmux/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client.ts")>()
  return {
    ...actual,
    KOBE_TMUX_SOCKET: "kobe-test",
    tmuxAvailable: mocks.tmuxAvailable,
    runTmuxCapturing: mocks.runTmuxCapturing,
  }
})

import { paneProcessGroups, parsePsRows, resourceDoctorLines } from "../../src/cli/doctor-resources"

describe("parsePsRows", () => {
  test("parses pid/pgid/rss/comm, skipping the header row", () => {
    const output = ["  PID  PGID    RSS COMM", "  501   501   3168 kobe tasks", "  502   501   1536 /bin/sh"].join("\n")
    expect(parsePsRows(output)).toEqual([
      { pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" },
      { pid: 502, pgid: 501, rssKb: 1536, comm: "/bin/sh" },
    ])
  })

  test("ignores blank lines and unparseable rows", () => {
    const output = ["  PID  PGID    RSS COMM", "", "   not a row at all", "  501   501   3168 kobe ops"].join("\n")
    expect(parsePsRows(output)).toEqual([{ pid: 501, pgid: 501, rssKb: 3168, comm: "kobe ops" }])
  })

  test("empty input yields no rows", () => {
    expect(parsePsRows("")).toEqual([])
    expect(parsePsRows("  PID  PGID    RSS COMM")).toEqual([])
  })
})

describe("paneProcessGroups", () => {
  test("keeps only rows whose pgid is one of the given pane pids", () => {
    const rows = [
      { pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" },
      { pid: 610, pgid: 600, rssKb: 9000, comm: "claude" },
      { pid: 1, pgid: 1, rssKb: 9999, comm: "launchd" },
    ]
    expect(paneProcessGroups(rows, [501, 600])).toEqual([rows[0], rows[1]])
  })

  test("no matching pane pids yields no rows", () => {
    const rows = [{ pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" }]
    expect(paneProcessGroups(rows, [999])).toEqual([])
  })
})

describe("resourceDoctorLines", () => {
  beforeEach(() => {
    mocks.tmuxAvailable.mockReset()
    mocks.runTmuxCapturing.mockReset()
    mocks.bunSpawn.mockReset()
    vi.stubGlobal("Bun", { spawn: mocks.bunSpawn })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("tmux not installed", async () => {
    mocks.tmuxAvailable.mockResolvedValue(false)
    expect(await resourceDoctorLines()).toEqual(["resources: tmux not installed — no kobe sessions to measure"])
  })

  test("tmux installed, no kobe panes", async () => {
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.runTmuxCapturing.mockResolvedValue({ code: 0, stdout: "" })
    expect(await resourceDoctorLines()).toEqual(["resources: 0 process(es) on `kobe-test`"])
  })

  test("groups pane-group processes by command with RSS totals", async () => {
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.runTmuxCapturing.mockResolvedValue({ code: 0, stdout: "501\n502\n" })
    mocks.bunSpawn.mockImplementation(() => ({
      stdout: new Response(
        ["  PID  PGID    RSS COMM", "  501   501   3168 zsh", "  510   501   9000 bun", "  502   502   1536 zsh"].join(
          "\n",
        ),
      ).body,
      exited: Promise.resolve(0),
    }))
    const lines = await resourceDoctorLines()
    expect(lines[0]).toBe("resources: 3 process(es) across 2 pane(s) on `kobe-test`, 13.4 MB RSS total")
    expect(lines).toContain("           bun: 1 proc, 8.8 MB")
    expect(lines).toContain("           zsh: 2 proc, 4.6 MB")
  })

  test("list-panes failure yields zero pane pids, not a crash", async () => {
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.runTmuxCapturing.mockResolvedValue({ code: 1, stdout: "" })
    expect(await resourceDoctorLines()).toEqual(["resources: 0 process(es) on `kobe-test`"])
  })
})
