import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { setPersistedString } from "../../src/state/repos.ts"
import {
  getPersistedBool,
  loadStateFile,
  patchStateFile,
  replaceStateFile,
  setPersistedBool,
  updateStateFile,
} from "../../src/state/store.ts"

let tmpHome: string
let originalHome: string | undefined

function statePath(): string {
  return path.join(tmpHome, ".config", "kobe", "state.json")
}

function readDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(), "utf8")) as Record<string, unknown>
}

function writeDisk(blob: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify(blob), "utf8")
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-store-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/repos.test.ts.
  if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("loadStateFile", () => {
  test("returns {} when the file does not exist", () => {
    expect(loadStateFile()).toEqual({})
  })

  test("returns {} for malformed JSON", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), "{not valid json", "utf8")
    expect(loadStateFile()).toEqual({})
  })

  test("returns {} for a non-object JSON root", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(["a", "b"]), "utf8")
    expect(loadStateFile()).toEqual({})
  })
})

describe("patchStateFile — the lost-update fix", () => {
  test("interleaved writers do not lose each other's keys", () => {
    writeDisk({ activeTheme: "claude" })

    const processASnapshot = loadStateFile()
    expect(processASnapshot).toEqual({ activeTheme: "claude" })

    setPersistedString("lastSelectedVendor", "codex")

    patchStateFile({ activeTheme: "tokyonight" })

    expect(readDisk()).toEqual({
      activeTheme: "tokyonight",
      lastSelectedVendor: "codex",
    })
  })

  test("merges only the patched keys, preserving siblings", () => {
    writeDisk({ a: 1, b: "two", nested: { keep: true } })
    patchStateFile({ b: "TWO" })
    expect(readDisk()).toEqual({ a: 1, b: "TWO", nested: { keep: true } })
  })

  test("a patch value of undefined deletes the key", () => {
    writeDisk({ doomed: "x", kept: "y" })
    patchStateFile({ doomed: undefined })
    expect(readDisk()).toEqual({ kept: "y" })
  })

  test("creates the directory and file on first write", () => {
    expect(fs.existsSync(statePath())).toBe(false)
    patchStateFile({ savedRepos: ["/x"] })
    expect(readDisk()).toEqual({ savedRepos: ["/x"] })
  })

  test("rebuilds a valid file when merging onto corrupt JSON", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), "<<garbage>>", "utf8")
    patchStateFile({ recovered: true })
    expect(readDisk()).toEqual({ recovered: true })
  })

  test("write is tmp+rename: no .tmp file survives a flush", () => {
    patchStateFile({ k: "v" })
    expect(fs.existsSync(`${statePath()}.tmp`)).toBe(false)
    expect(readDisk()).toEqual({ k: "v" })
  })
})

describe("updateStateFile", () => {
  test("mutator sees the current on-disk state and its result is written", () => {
    writeDisk({ savedRepos: ["/a"] })
    const result = updateStateFile((state) => {
      const cur = state.savedRepos as string[]
      state.savedRepos = [...cur, "/b"]
      return undefined
    })
    expect(result.savedRepos).toEqual(["/a", "/b"])
    expect(readDisk()).toEqual({ savedRepos: ["/a", "/b"] })
  })

  test("mutator returning false skips the write entirely", () => {
    updateStateFile(() => false)
    expect(fs.existsSync(statePath())).toBe(false)

    writeDisk({ keep: 1 })
    const before = fs.statSync(statePath()).mtimeMs
    updateStateFile((state) => {
      state.keep = 999
      return false
    })
    expect(readDisk()).toEqual({ keep: 1 })
    expect(fs.statSync(statePath()).mtimeMs).toBe(before)
  })
})

describe("replaceStateFile", () => {
  test("replaces the whole file, discarding unknown siblings", () => {
    writeDisk({ activeTheme: "claude", lastSelectedVendor: "codex" })
    replaceStateFile({})
    expect(readDisk()).toEqual({})
    expect(fs.existsSync(`${statePath()}.tmp`)).toBe(false)
  })
})

describe("getPersistedBool / setPersistedBool", () => {
  test("missing key falls back to the given default (either polarity)", () => {
    expect(getPersistedBool("nope", false)).toBe(false)
    expect(getPersistedBool("nope", true)).toBe(true)
  })

  test("a real stored boolean overrides the default", () => {
    writeDisk({ flagA: true, flagB: false })
    expect(getPersistedBool("flagA", false)).toBe(true)
    expect(getPersistedBool("flagB", true)).toBe(false)
  })

  test("non-boolean values fall back to the default", () => {
    writeDisk({ s: "true", n: 1, z: 0, nul: null })
    expect(getPersistedBool("s", false)).toBe(false)
    expect(getPersistedBool("n", false)).toBe(false)
    expect(getPersistedBool("z", true)).toBe(true)
    expect(getPersistedBool("nul", true)).toBe(true)
  })

  test("setPersistedBool round-trips through the merge writer", () => {
    setPersistedBool("k", true)
    expect(getPersistedBool("k", false)).toBe(true)
    expect(readDisk().k).toBe(true)
    setPersistedBool("k", false)
    expect(getPersistedBool("k", true)).toBe(false)
  })
})
