/**
 * Unit tests for `src/state/keybindings-file.ts` — the shared, cached reader
 * for `~/.kobe/settings/keybindings.yaml`.
 *
 * Why these matter: two consumers (the opentui keymap loader and the tmux
 * resolver) parse this one file; the reader is the seam that keeps them
 * consistent. The cache semantics are load-bearing — a second disk read
 * could only make the two consumers disagree — and a broken/unparseable
 * file must degrade to warnings, never a throw at TUI boot.
 *
 * The module parses via `Bun.YAML`; vitest runs under Node, so the global is
 * stubbed with a JSON-based parser (the reader only cares that parse() maps
 * text → doc or throws).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { parse } from "yaml"
import { readKeybindingsFile, resetKeybindingsFileCache, writePrefixKey } from "../../src/state/keybindings-file.ts"

let tmpHome: string
let originalHome: string | undefined

function settingsDir(): string {
  return path.join(tmpHome, ".rove", "settings")
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-kbfile-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  vi.stubGlobal("Bun", {
    YAML: {
      parse: (text: string) => {
        if (text.startsWith("!!broken")) throw new Error("unexpected token")
        return parse(text)
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
      JSON.stringify({ bindings: { "chat.tab.new": "ctrl+y" } }),
    )
    const r = readKeybindingsFile()
    expect(r.exists).toBe(true)
    expect(r.doc).toEqual({ bindings: { "chat.tab.new": "ctrl+y" } })
    expect(r.warnings).toEqual([])
  })

  test("falls back to .yml when .yaml is absent, but reports the canonical path", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    fs.writeFileSync(path.join(settingsDir(), "keybindings.yml"), JSON.stringify({ bindings: {} }))
    const r = readKeybindingsFile()
    expect(r.exists).toBe(true)
    expect(r.doc).toEqual({ bindings: {} })
    // Canonical spelling even though the .yml file was read.
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
    // Same object back — the edit is invisible without a reset.
    expect(readKeybindingsFile()).toBe(first)

    resetKeybindingsFileCache()
    expect(readKeybindingsFile().doc).toEqual({ bindings: { a: "ctrl+b" } })
  })
})

describe("writePrefixKey", () => {
  test("creates the canonical file and resets the reader cache", () => {
    expect(readKeybindingsFile().exists).toBe(false)
    const file = writePrefixKey("ctrl+b", "linux")

    expect(file).toBe(path.join(settingsDir(), "keybindings.yaml"))
    expect(parse(fs.readFileSync(file, "utf8"))).toEqual({ prefix: { key: "ctrl+b" } })
    expect(readKeybindingsFile()).toMatchObject({ exists: true, doc: { prefix: { key: "ctrl+b" } } })
  })

  test("updates the effective platform overlay while preserving comments and other bindings", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const file = path.join(settingsDir(), "keybindings.yaml")
    fs.writeFileSync(
      file,
      [
        "# keep this header",
        "prefix:",
        "  key: ctrl+a # shared default",
        "bindings:",
        "  chat.tab.new: ctrl+t",
        "linux:",
        "  prefix:",
        "    key: ctrl+x # linux override",
        "",
      ].join("\n"),
    )

    writePrefixKey("alt+b", "linux")

    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("# keep this header")
    expect(text).toContain("# shared default")
    expect(text).toContain("# linux override")
    expect(parse(text)).toEqual({
      prefix: { key: "ctrl+a" },
      bindings: { "chat.tab.new": "ctrl+t" },
      linux: { prefix: { key: "alt+b" } },
    })
  })

  test("promotes an existing .yml fallback to the daemon-watched canonical path", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const yml = path.join(settingsDir(), "keybindings.yml")
    fs.writeFileSync(yml, "bindings:\n  sidebar.rename: ctrl+r\n")

    const canonical = path.join(settingsDir(), "keybindings.yaml")
    expect(writePrefixKey(null, "linux")).toBe(canonical)
    expect(fs.readFileSync(yml, "utf8")).toBe("bindings:\n  sidebar.rename: ctrl+r\n")
    expect(parse(fs.readFileSync(canonical, "utf8"))).toEqual({
      bindings: { "sidebar.rename": "ctrl+r" },
      prefix: { key: null },
    })
  })

  test("updates the last platform alias because it is the effective override", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const file = path.join(settingsDir(), "keybindings.yaml")
    fs.writeFileSync(file, "darwin:\n  prefix:\n    key: ctrl+x\nmac:\n  prefix:\n    key: ctrl+y\n")

    writePrefixKey("cmd+b", "darwin")

    expect(parse(fs.readFileSync(file, "utf8"))).toEqual({
      darwin: { prefix: { key: "ctrl+x" } },
      mac: { prefix: { key: "cmd+b" } },
    })
  })

  test("refuses malformed YAML without changing the file", () => {
    fs.mkdirSync(settingsDir(), { recursive: true })
    const file = path.join(settingsDir(), "keybindings.yaml")
    fs.writeFileSync(file, "prefix: [\n")

    expect(() => writePrefixKey("ctrl+b", "linux")).toThrow("could not parse")
    expect(fs.readFileSync(file, "utf8")).toBe("prefix: [\n")
  })
})
