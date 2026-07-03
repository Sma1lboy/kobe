/**
 * `applyTmuxChromeTheme` — the IO wrapper over the pure planners already
 * pinned in tmux-border-theme.test.ts. What only THIS layer decides:
 * reading prefs from state.json (theme name, focus-accent slot, the
 * `tmuxChromeTheme: "off"` kill switch), reading current option values via
 * `show-options -gqv`, and only invoking `runTmuxSequence` when the plan is
 * non-empty. tmux itself is mocked at the `tmux/client` seam.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runTmuxCapturing: vi.fn(async (_args: string[]) => ({ code: 0, stdout: "", stderr: "" })),
  runTmuxSequence: vi.fn(async (_cmds: string[][]) => {}),
}))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return { ...actual, runTmuxCapturing: mocks.runTmuxCapturing, runTmuxSequence: mocks.runTmuxSequence }
})

import { kvStatePath } from "../../src/env"
import { applyTmuxChromeTheme } from "../../src/tui/lib/tmux-border-theme"

let home: string
let prevHome: string | undefined

function writeState(state: Record<string, unknown>): void {
  const path = kvStatePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
}

beforeEach(() => {
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "kobe-chrome-apply-"))
  prevHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = home
  mocks.runTmuxCapturing.mockResolvedValue({ code: 0, stdout: "", stderr: "" })
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe("applyTmuxChromeTheme", () => {
  test("stock server + default (claude) theme: claims the chrome options and records the marker", async () => {
    // No state.json at all → defaults (claude theme, enabled).
    await applyTmuxChromeTheme()

    expect(mocks.runTmuxSequence).toHaveBeenCalledTimes(1)
    const cmds = mocks.runTmuxSequence.mock.calls[0]?.[0] as string[][]
    const options = cmds.map((c) => c[2])
    expect(options).toContain("pane-border-style")
    expect(options).toContain("pane-active-border-style")
    expect(options).toContain("status-style")
    // Last command records ownership in the marker option.
    expect(cmds.at(-1)).toEqual(["set-option", "-g", "@kobe_border_theme", expect.stringContaining("border")])
    // Styles are real hex colors from the bundled claude theme, not empty.
    const border = cmds.find((c) => c[2] === "pane-border-style")
    expect(border?.[3]).toMatch(/^fg=#[0-9a-fA-F]{6}$/)
  })

  test("`tmuxChromeTheme: off` on a marker-less server plans nothing — no tmux writes", async () => {
    writeState({ tmuxChromeTheme: "off" })

    await applyTmuxChromeTheme()

    expect(mocks.runTmuxSequence).not.toHaveBeenCalled()
  })

  test("`off` with kobe-owned options releases exactly what the marker says kobe wrote", async () => {
    writeState({ tmuxBorderTheme: "off" }) // legacy key also disables
    mocks.runTmuxCapturing.mockImplementation(async (args: string[]) => {
      if (args.includes("@kobe_border_theme")) return { code: 0, stdout: "border,active\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    })

    await applyTmuxChromeTheme()

    const cmds = mocks.runTmuxSequence.mock.calls[0]?.[0] as string[][]
    expect(cmds).toContainEqual(["set-option", "-gwu", "pane-border-style"])
    expect(cmds).toContainEqual(["set-option", "-gwu", "pane-active-border-style"])
    expect(cmds).toContainEqual(["set-option", "-gu", "@kobe_border_theme"])
    // Never unsets options kobe didn't own (marker listed only border,active).
    expect(cmds.some((c) => c[2] === "status-style")).toBe(false)
  })

  test("already-applied styles plan zero commands (idempotent re-apply)", async () => {
    // First apply on a stock server, capture what kobe wrote…
    await applyTmuxChromeTheme()
    const first = mocks.runTmuxSequence.mock.calls[0]?.[0] as string[][]
    const applied = new Map(first.filter((c) => c[3] !== undefined).map((c) => [c[2], c[3]]))
    const marker = first.at(-1)?.[3] ?? ""
    mocks.runTmuxSequence.mockClear()

    // …then report those exact values back on the second pass.
    mocks.runTmuxCapturing.mockImplementation(async (args: string[]) => {
      const option = args.at(-1) ?? ""
      if (option === "@kobe_border_theme") return { code: 0, stdout: `${marker}\n`, stderr: "" }
      return { code: 0, stdout: `${applied.get(option) ?? ""}\n`, stderr: "" }
    })

    await applyTmuxChromeTheme()

    expect(mocks.runTmuxSequence).not.toHaveBeenCalled()
  })

  test("a tmux read failure reads as unset (code!=0 → empty current) and never throws", async () => {
    mocks.runTmuxCapturing.mockResolvedValue({ code: 1, stdout: "irrelevant", stderr: "no server" })

    await expect(applyTmuxChromeTheme()).resolves.toBeUndefined()
    // Unreadable currents look unset, so the plan claims them all.
    expect(mocks.runTmuxSequence).toHaveBeenCalledTimes(1)
  })

  test("an unknown theme name releases instead of painting black", async () => {
    writeState({ activeTheme: "no-such-theme" })
    mocks.runTmuxCapturing.mockImplementation(async (args: string[]) => {
      if (args.includes("@kobe_border_theme")) return { code: 0, stdout: "border\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    })

    await applyTmuxChromeTheme()

    const cmds = mocks.runTmuxSequence.mock.calls[0]?.[0] as string[][]
    // Only releases (unset flags) — no set-option with a style value.
    expect(cmds.every((c) => c[1] === "-gwu" || c[1] === "-gu")).toBe(true)
  })
})
