import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  optionValues: {} as Record<string, string>,
  sequences: [] as string[][],
}))

vi.mock("../../src/tmux/client", () => ({
  runTmuxCapturing: vi.fn(async (args: string[]) => {
    const option = args[args.length - 1] ?? ""
    const value = state.optionValues[option]
    return value === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `${value}\n` }
  }),
  runTmuxSequence: vi.fn(async (commands: readonly (readonly string[])[]) => {
    for (const c of commands) state.sequences.push([...c])
    return 0
  }),
}))

const theme = await import("../../src/tui/lib/tmux-border-theme")

let home: string
let prevHome: string | undefined

function writeStateJson(content: Record<string, unknown>): void {
  const dir = join(home, ".config", "kobe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "state.json"), JSON.stringify(content))
}

beforeEach(() => {
  state.optionValues = {}
  state.sequences = []
  vi.clearAllMocks()
  prevHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-chrome-"))
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  rmSync(home, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe("applyTmuxChromeTheme", () => {
  test("a fresh server gets the active theme's chrome options set + the ownership marker", async () => {
    writeStateJson({ activeTheme: "claude" })
    await theme.applyTmuxChromeTheme()
    expect(state.sequences.length).toBeGreaterThan(0)
    expect(state.sequences.every((c) => c[0] === "set-option")).toBe(true)
    const marker = state.sequences.find((c) => c.includes("@kobe_border_theme"))
    expect(marker).toBeDefined()
  })

  test("idempotent: a server already at the planned values plans zero commands", async () => {
    writeStateJson({ activeTheme: "claude" })
    await theme.applyTmuxChromeTheme()
    const applied = [...state.sequences]
    for (const cmd of applied) {
      const option = cmd[cmd.length - 2]
      const value = cmd[cmd.length - 1]
      if (option && value !== undefined) state.optionValues[option] = value
    }
    state.sequences = []
    await theme.applyTmuxChromeTheme()
    expect(state.sequences).toEqual([])
  })

  test("`tmuxChromeTheme: off` releases previously-owned options instead of styling", async () => {
    writeStateJson({ activeTheme: "claude", tmuxChromeTheme: "off" })
    state.optionValues["@kobe_border_theme"] = "border,active"
    state.optionValues["pane-border-style"] = "fg=#111111"
    state.optionValues["pane-active-border-style"] = "fg=#222222"
    await theme.applyTmuxChromeTheme()
    const unsets = state.sequences.filter((c) => c.includes("-gu") || c.includes("-u"))
    expect(unsets.length).toBeGreaterThan(0)
  })

  test("an unknown theme name plans a release, not garbage colors", async () => {
    writeStateJson({ activeTheme: "no-such-theme" })
    await theme.applyTmuxChromeTheme()
    expect(state.sequences).toEqual([])
  })

  test("a corrupt state.json degrades to the claude default, never throws", async () => {
    const dir = join(home, ".config", "kobe")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "state.json"), "{not json")
    await expect(theme.applyTmuxChromeTheme()).resolves.toBeUndefined()
    expect(state.sequences.length).toBeGreaterThan(0)
  })

  test("tmux failures never surface to the caller", async () => {
    writeStateJson({ activeTheme: "claude" })
    const client = await import("../../src/tmux/client")
    vi.mocked(client.runTmuxSequence).mockRejectedValueOnce(new Error("server gone"))
    await expect(theme.applyTmuxChromeTheme()).resolves.toBeUndefined()
  })

  test("applyTmuxPaneBorderTheme is the legacy alias for the same pipeline", async () => {
    writeStateJson({ activeTheme: "claude" })
    await theme.applyTmuxPaneBorderTheme()
    expect(state.sequences.length).toBeGreaterThan(0)
  })
})
