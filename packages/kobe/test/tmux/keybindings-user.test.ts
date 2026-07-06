import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { resetKeybindingsFileCache } from "../../src/state/keybindings-file.ts"
import { resetTmuxKeysCache, resolveUserTmuxKeys, tmuxChordOptsFor } from "../../src/tmux/keybindings.ts"

let tmpHome: string
let originalHome: string | undefined
let warnSpy: ReturnType<typeof vi.spyOn>

function writeConfig(bindings: Record<string, unknown>): void {
  const dir = path.join(tmpHome, ".kobe", "settings")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "keybindings.yaml"), JSON.stringify({ bindings }))
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-tmuxkeys-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  vi.stubGlobal("Bun", { YAML: { parse: (text: string) => JSON.parse(text) } })
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  resetKeybindingsFileCache()
  resetTmuxKeysCache()
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetKeybindingsFileCache()
  resetTmuxKeysCache()
})

describe("tmuxChordOptsFor", () => {
  test("allows shift+letter only for tmux.* ids", () => {
    expect(tmuxChordOptsFor("tmux.tab.chooseEngine")).toEqual({ allowShiftCharacter: true })
    expect(tmuxChordOptsFor("chat.fork.new")).toEqual({})
  })
})

describe("resolveUserTmuxKeys", () => {
  test("no config file → the shipped defaults, nothing overridden, no warnings logged", () => {
    const res = resolveUserTmuxKeys()
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: "ctrl+t", key: "C-t" })
    expect(res.overridden.size).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("applies tmux.* overrides from the YAML (incl. a shift+letter chord)", () => {
    writeConfig({ "tmux.tab.new": "ctrl+y", "tmux.tab.chooseEngine": "ctrl+shift+e", "chat.fork.new": "ctrl+g" })
    const res = resolveUserTmuxKeys()
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: "ctrl+y", key: "C-y" })
    expect(res.binds["tmux.tab.chooseEngine"]).toEqual({ chord: "ctrl+shift+e", key: "C-S-E" })
    expect(res.overridden.has("tmux.tab.new")).toBe(true)
    expect(res.warnings).toEqual([])
  })

  test("console-logs each tmux warning once and keeps the default for the bad id", () => {
    writeConfig({ "tmux.tab.new": "cmd+t" })
    const res = resolveUserTmuxKeys()
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: "ctrl+t", key: "C-t" })
    expect(res.warnings.some((w) => w.includes("Command key"))).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[kobe/keybindings]"))
  })

  test("cached until resetTmuxKeysCache — an edited file is invisible to the same process", () => {
    writeConfig({ "tmux.tab.new": "ctrl+y" })
    const first = resolveUserTmuxKeys()
    expect(first.binds["tmux.tab.new"]?.key).toBe("C-y")

    writeConfig({ "tmux.tab.new": "ctrl+u" })
    expect(resolveUserTmuxKeys()).toBe(first)

    resetKeybindingsFileCache()
    resetTmuxKeysCache()
    expect(resolveUserTmuxKeys().binds["tmux.tab.new"]?.key).toBe("C-u")
  })
})
