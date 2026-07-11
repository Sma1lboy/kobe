/**
 * Unit tests for `src/state/store.ts` — the single owner of
 * `~/.config/kobe/state.json` I/O.
 *
 * The module exists to fix a multi-process lost-update bug: the TUI's
 * KVProvider used to debounce-write its ENTIRE in-memory snapshot, so a
 * key another kobe process (Tasks pane, quick-task, a CLI command) wrote
 * in the meantime was silently reverted on the next flush. These tests
 * pin the read-merge-write contract that prevents that, plus the
 * atomicity and corrupt-file behaviors carried over from the two former
 * writers.
 *
 * Same isolation pattern as test/state/repos.test.ts: redirect HOME via
 * `KOBE_HOME_DIR` to a per-test tmpdir so the real `~/.config/kobe/` is
 * never touched.
 */
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
  // Why: a fresh machine has no state.json; every reader treats that as
  // "no persisted prefs", never as an error.
  test("returns {} when the file does not exist", () => {
    expect(loadStateFile()).toEqual({})
  })

  // Why: corrupt-file policy — a malformed state.json must not block the
  // UI or a CLI run. It reads as {} and gets rebuilt on the next write.
  // (This silently discards whatever was in the corrupt file; that is the
  // documented, pre-existing trade-off carried over from both former
  // writers, kv.tsx and repos.ts.)
  test("returns {} for malformed JSON", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), "{not valid json", "utf8")
    expect(loadStateFile()).toEqual({})
  })

  // Why: a non-object root (array, string) would break every keyed reader
  // downstream — treat it like corruption, not like data.
  test("returns {} for a non-object JSON root", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(["a", "b"]), "utf8")
    expect(loadStateFile()).toEqual({})
  })

  // Why: a corrupt file must not be silently discarded — it's backed up
  // (aligned with tasks.json's "stale file is left in place" policy) so the
  // data is forensically recoverable, and the original path is freed for the
  // next write to rebuild cleanly.
  test("backs up malformed JSON to a .corrupt-<ts> file instead of deleting it", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), "{not valid json", "utf8")
    expect(loadStateFile()).toEqual({})
    expect(fs.existsSync(statePath())).toBe(false)
    const dir = fs.readdirSync(path.dirname(statePath()))
    const backup = dir.find((f) => f.startsWith("state.json.corrupt-"))
    expect(backup).toBeDefined()
    expect(fs.readFileSync(path.join(path.dirname(statePath()), backup as string), "utf8")).toBe("{not valid json")
  })
})

describe("patchStateFile — the lost-update fix", () => {
  test("interleaved writers do not lose each other's keys", () => {
    writeDisk({ activeTheme: "claude" })

    // Process A boots and takes its in-memory snapshot.
    const processASnapshot = loadStateFile()
    expect(processASnapshot).toEqual({ activeTheme: "claude" })

    // Process B (another kobe process) persists a new key via the public
    // repos.ts API — the real cross-process write path.
    setPersistedString("lastSelectedVendor", "codex")

    // Process A flushes its one dirty key. Its snapshot never contained
    // lastSelectedVendor — under whole-snapshot write-back this is the
    // moment B's write used to be erased.
    patchStateFile({ activeTheme: "tokyonight" })

    expect(readDisk()).toEqual({
      activeTheme: "tokyonight",
      lastSelectedVendor: "codex",
    })
  })

  // Why: the patch must apply ONLY the keys the caller changed — sibling
  // keys it never touched pass through byte-for-byte. This is the
  // single-key read-merge-write that setPersistedString relies on.
  test("merges only the patched keys, preserving siblings", () => {
    writeDisk({ a: 1, b: "two", nested: { keep: true } })
    patchStateFile({ b: "TWO" })
    expect(readDisk()).toEqual({ a: 1, b: "TWO", nested: { keep: true } })
  })

  // Why: an explicit `undefined` deletes the key. KVProvider's old
  // whole-snapshot write dropped undefined entries at stringify time;
  // the dirty-key patch must serialize the same way or a `kv.set(k,
  // undefined)` would silently stop deleting.
  test("a patch value of undefined deletes the key", () => {
    writeDisk({ doomed: "x", kept: "y" })
    patchStateFile({ doomed: undefined })
    expect(readDisk()).toEqual({ kept: "y" })
  })

  // Why: first-ever write on a fresh machine — the .config/kobe dir
  // doesn't exist yet and the writer is responsible for creating it.
  test("creates the directory and file on first write", () => {
    expect(fs.existsSync(statePath())).toBe(false)
    patchStateFile({ savedRepos: ["/x"] })
    expect(readDisk()).toEqual({ savedRepos: ["/x"] })
  })

  // Why: corrupt-file recovery on the WRITE side — merging onto a corrupt
  // file bases the merge on {} (matching loadStateFile) and rebuilds a
  // valid file rather than throwing or appending to garbage.
  test("rebuilds a valid file when merging onto corrupt JSON", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), "<<garbage>>", "utf8")
    patchStateFile({ recovered: true })
    expect(readDisk()).toEqual({ recovered: true })
  })

  // Why: atomicity. The write goes tmp+rename so a crash mid-write can't
  // leave a half-written state.json. We can't crash mid-write in a unit
  // test, but we CAN pin the observable contract: after a write the tmp
  // file is gone (renamed, not copied-and-left-behind) and the target
  // parses cleanly.
  test("write is tmp+rename: no .tmp file survives a flush", () => {
    patchStateFile({ k: "v" })
    expect(fs.existsSync(`${statePath()}.tmp`)).toBe(false)
    expect(readDisk()).toEqual({ k: "v" })
  })

  // Why: a fixed shared tmp path lets two processes' writeFileSync calls
  // interleave on the same inode before either renames — the tmp name must
  // be unique per write so concurrent flushes can never collide.
  test("tmp filename is unique per write (pid + nonce), no leftover after flush", () => {
    patchStateFile({ a: 1 })
    patchStateFile({ b: 2 })
    const leftover = fs.readdirSync(path.dirname(statePath())).filter((f) => f.includes(".tmp"))
    expect(leftover).toEqual([])
    expect(readDisk()).toEqual({ a: 1, b: 2 })
  })
})

describe("updateStateFile", () => {
  // Why: read-modify-write transactions (addSavedRepo etc.) need the read
  // and the write to share ONE fresh snapshot — the mutator sees what is
  // on disk now, not what some earlier load() saw.
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

  // Why: no-op guard. "Repo already saved" paths return false so an
  // idempotent re-add doesn't churn the file (mtime, watchers, and one
  // fewer pointless write racing other processes).
  test("mutator returning false skips the write entirely", () => {
    updateStateFile(() => false)
    expect(fs.existsSync(statePath())).toBe(false)

    writeDisk({ keep: 1 })
    const before = fs.statSync(statePath()).mtimeMs
    updateStateFile((state) => {
      state.keep = 999 // mutation is discarded when we return false
      return false
    })
    expect(readDisk()).toEqual({ keep: 1 })
    expect(fs.statSync(statePath()).mtimeMs).toBe(before)
  })
})

describe("replaceStateFile", () => {
  // Why: clear()'s contract is the deliberate exception to merging —
  // "reset UI state" must wipe keys other processes wrote too, including
  // ones this process never loaded. Pin that it really is a whole-file
  // replace, so nobody "fixes" it into a merge and breaks the reset.
  test("replaces the whole file, discarding unknown siblings", () => {
    writeDisk({ activeTheme: "claude", lastSelectedVendor: "codex" })
    replaceStateFile({})
    expect(readDisk()).toEqual({})
    expect(fs.existsSync(`${statePath()}.tmp`)).toBe(false)
  })
})

describe("getPersistedBool / setPersistedBool", () => {
  // Why: the default is explicit and only a REAL stored boolean overrides it.
  // This is the footgun the helper exists to kill — a missing key must not be
  // read as false when the flag defaults true (zen.keepTasks), and vice versa.
  test("missing key falls back to the given default (either polarity)", () => {
    expect(getPersistedBool("nope", false)).toBe(false)
    expect(getPersistedBool("nope", true)).toBe(true)
  })

  test("a real stored boolean overrides the default", () => {
    writeDisk({ flagA: true, flagB: false })
    expect(getPersistedBool("flagA", false)).toBe(true)
    expect(getPersistedBool("flagB", true)).toBe(false)
  })

  // Why: a non-boolean value (legacy string, garbage) must NOT be coerced —
  // it falls back to the default, not `Boolean(value)`.
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
