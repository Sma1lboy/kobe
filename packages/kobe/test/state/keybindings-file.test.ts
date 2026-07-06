import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readKeybindingsFile, resetKeybindingsFileCache } from "../../src/state/keybindings-file.ts"

let tmpHome: string
let originalHome: string | undefined

function settingsDir(): string {
  return path.join(tmpHome, ".kobe", "settings")
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-kbfile-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  vi.stubGlobal("Bun", {
    YAML: {
      parse: (text: string) => {
        if (text.startsWith("!!broken")) throw new Error("unexpected token")
        return JSON.parse(text)
      },
    },
  })
  resetKeybindingsFileCache()
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
  resetKeybindingsFileCache()
})

describe("readKeybindingsFile", () => {
  test("missing file → exists=false, null doc, no warnings", () => {
    const r = readKeybindingsFile()
    expect(r).toEqual({
      path: path.join(settingsDir(), "keybindings.yaml"),
      exists: false,
      doc: null,
      warnings: [],
    })
  })

  test("reads + parses the canonical .yaml file", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir(), "keybindings.yaml"),
      JSON.stringify({ bindings: { "tmux.detach": "ctrl+y" } }),
    )
    const r = readKeybindingsFile()
    expect(r.exists).toBe(true)
    expect(r.doc).toEqual({ bindings: { "tmux.detach": "ctrl+y" } })
    expect(r.warnings).toEqual([])
  })

  test("falls back to .yml when .yaml is absent, but reports the canonical path", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    fs.writeFileSync(path.join(settingsDir(), "keybindings.yml"), JSON.stringify({ bindings: {} }))
    const r = readKeybindingsFile()
    expect(r.exists).toBe(true)
    expect(r.doc).toEqual({ bindings: {} })
    expect(r.path).toBe(path.join(settingsDir(), "keybindings.yaml"))
  })

  test("unparseable file → exists=true, null doc, one warning naming the file (never throws)", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const file = path.join(settingsDir(), "keybindings.yaml")
    fs.writeFileSync(file, "!!broken")
    const r = readKeybindingsFile()
    expect(r.exists).toBe(true)
    expect(r.doc).toBeNull()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain(file)
    expect(r.warnings[0]).toContain("unexpected token")
  })

  test("cached: a second call does not re-read the file until the cache is reset", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const file = path.join(settingsDir(), "keybindings.yaml")
    fs.writeFileSync(file, JSON.stringify({ bindings: { a: "ctrl+a" } }))
    const first = readKeybindingsFile()
    expect(first.doc).toEqual({ bindings: { a: "ctrl+a" } })

    fs.writeFileSync(file, JSON.stringify({ bindings: { a: "ctrl+b" } }))
    expect(readKeybindingsFile()).toBe(first)

    resetKeybindingsFileCache()
    expect(readKeybindingsFile().doc).toEqual({ bindings: { a: "ctrl+b" } })
  })
})
