/**
 * Unit tests for `src/state/repos.ts`.
 *
 * The module reads/writes the same on-disk KV blob the TUI uses
 * (`~/.config/kobe/state.json`), so the tests redirect HOME via
 * `KOBE_HOME_DIR` to a per-test tmpdir. Every state mutation is
 * scoped to that tmpdir; the real `~/.config/kobe/` is untouched.
 *
 * What we pin:
 *   - `getSavedRepos()` returns `[]` when the file doesn't exist.
 *   - `getSavedRepos()` returns `[]` when the file is malformed.
 *   - `addSavedRepo()` creates the file + directory on first write.
 *   - `addSavedRepo()` is idempotent (re-add returns `added: false`).
 *   - `addSavedRepo()` preserves any sibling KV keys already in the
 *     file — this is the load-bearing reason `repos.ts` and `kv.tsx`
 *     read/write the SAME blob: a `kobe add` from a shell mustn't
 *     wipe the user's `lastSelectedTaskId` / `activeTheme` / etc.
 *   - `addSavedRepo()` preserves order of existing entries.
 *   - The total in `AddResult` matches the post-write list size.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  addRemoteRepo,
  addSavedRepo,
  getCustomEngineIds,
  getRemoteRepoConfig,
  getSavedRepos,
  isGitRepo,
  removeSavedRepo,
  statePath,
} from "../../src/state/repos.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-repos-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/tui/user-slashes.test.ts.
  if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("statePath", () => {
  test("resolves under KOBE_HOME_DIR", () => {
    expect(statePath()).toBe(path.join(tmpHome, ".config", "kobe", "state.json"))
  })
})

describe("isGitRepo", () => {
  test("true inside a real git work tree (and its subdirectories)", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-gitrepo-"))
    try {
      expect(spawnSync("git", ["init"], { cwd: repo }).status).toBe(0)
      expect(isGitRepo(repo)).toBe(true)
      const sub = path.join(repo, "packages", "x")
      fs.mkdirSync(sub, { recursive: true })
      expect(isGitRepo(sub)).toBe(true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test("false for an existing directory that is not a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-plain-"))
    try {
      expect(isGitRepo(plain)).toBe(false)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })

  test("false for a path that does not exist (the `kobe add ,` case)", () => {
    expect(isGitRepo(path.join(os.tmpdir(), "kobe-does-not-exist", ","))).toBe(false)
  })

  test("false for a remote (ssh://) key — validated by the remote-add flow", () => {
    expect(isGitRepo("ssh://user@host:22/srv/repo")).toBe(false)
  })
})

describe("getCustomEngineIds", () => {
  function writeState(blob: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(blob))
  }

  test("returns [] when the file does not exist", () => {
    expect(getCustomEngineIds()).toEqual([])
  })

  test("reads the customEngineIds array, dropping non-strings and blanks", () => {
    writeState({ customEngineIds: ["aider", "", 3, "  ", "my-engine"], savedRepos: ["/x"] })
    expect(getCustomEngineIds()).toEqual(["aider", "my-engine"])
  })

  test("returns [] when customEngineIds is absent or not an array", () => {
    writeState({ customEngineIds: "nope" })
    expect(getCustomEngineIds()).toEqual([])
  })
})

describe("getSavedRepos", () => {
  test("returns [] when the file does not exist", () => {
    expect(getSavedRepos()).toEqual([])
  })

  test("returns [] when the file is not parseable JSON", () => {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "{not valid json", "utf8")
    expect(getSavedRepos()).toEqual([])
  })

  test("returns [] when savedRepos is missing or wrong type", () => {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ activeTheme: "dracula" }), "utf8")
    expect(getSavedRepos()).toEqual([])
    fs.writeFileSync(p, JSON.stringify({ savedRepos: "/not/an/array" }), "utf8")
    expect(getSavedRepos()).toEqual([])
  })

  test("filters out non-string entries defensively", () => {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ savedRepos: ["/a", 42, null, "/b"] }), "utf8")
    expect(getSavedRepos()).toEqual(["/a", "/b"])
  })
})

describe("addSavedRepo", () => {
  test("creates the file + directory on first write and reports added=true", () => {
    expect(fs.existsSync(statePath())).toBe(false)
    const r = addSavedRepo("/repos/alpha")
    expect(r).toEqual({ added: true, path: "/repos/alpha", total: 1 })
    expect(getSavedRepos()).toEqual(["/repos/alpha"])
    expect(fs.existsSync(statePath())).toBe(true)
  })

  test("is idempotent — re-adding the same path returns added=false and doesn't grow", () => {
    addSavedRepo("/repos/alpha")
    const r = addSavedRepo("/repos/alpha")
    expect(r).toEqual({ added: false, path: "/repos/alpha", total: 1 })
    expect(getSavedRepos()).toEqual(["/repos/alpha"])
  })

  test("appends to existing entries in insertion order", () => {
    addSavedRepo("/repos/alpha")
    addSavedRepo("/repos/beta")
    addSavedRepo("/repos/gamma")
    expect(getSavedRepos()).toEqual(["/repos/alpha", "/repos/beta", "/repos/gamma"])
  })

  test("preserves sibling KV keys (kobe add must not wipe TUI state)", () => {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        activeTheme: "dracula",
        lastSelectedTaskId: "01XYZ",
        savedRepos: ["/old"],
      }),
      "utf8",
    )

    addSavedRepo("/new")

    const after = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>
    expect(after.activeTheme).toBe("dracula")
    expect(after.lastSelectedTaskId).toBe("01XYZ")
    expect(after.savedRepos).toEqual(["/old", "/new"])
  })

  test("write is atomic — no leftover .tmp after a successful add", () => {
    addSavedRepo("/repos/alpha")
    const dir = path.dirname(statePath())
    const entries = fs.readdirSync(dir)
    expect(entries).toContain("state.json")
    expect(entries).not.toContain("state.json.tmp")
  })
})

describe("removeSavedRepo (KOB-15)", () => {
  test("removes an entry and reports removed=true with the new total", () => {
    addSavedRepo("/repos/alpha")
    addSavedRepo("/repos/beta")
    const r = removeSavedRepo("/repos/alpha")
    expect(r).toEqual({ removed: true, path: "/repos/alpha", total: 1 })
    expect(getSavedRepos()).toEqual(["/repos/beta"])
  })

  test("is idempotent — removing a path that's not present returns removed=false", () => {
    addSavedRepo("/repos/alpha")
    const r = removeSavedRepo("/repos/never-added")
    expect(r).toEqual({ removed: false, path: "/repos/never-added", total: 1 })
    expect(getSavedRepos()).toEqual(["/repos/alpha"])
  })

  test("preserves sibling KV keys (must not wipe TUI state)", () => {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        activeTheme: "dracula",
        lastSelectedTaskId: "01XYZ",
        savedRepos: ["/old", "/keep"],
      }),
      "utf8",
    )
    removeSavedRepo("/old")
    const after = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>
    expect(after.activeTheme).toBe("dracula")
    expect(after.lastSelectedTaskId).toBe("01XYZ")
    expect(after.savedRepos).toEqual(["/keep"])
  })

  test("returns total=0 when removing the last entry", () => {
    addSavedRepo("/only")
    const r = removeSavedRepo("/only")
    expect(r).toEqual({ removed: true, path: "/only", total: 0 })
    expect(getSavedRepos()).toEqual([])
  })

  test("preserves order of remaining entries", () => {
    addSavedRepo("/a")
    addSavedRepo("/b")
    addSavedRepo("/c")
    addSavedRepo("/d")
    removeSavedRepo("/b")
    expect(getSavedRepos()).toEqual(["/a", "/c", "/d"])
  })

  test("removing a remote project also drops its remoteRepos config (no orphan)", () => {
    const { key } = addRemoteRepo({ host: "box", user: "jc", basePath: "/srv/work", auth: { kind: "key" } })
    expect(getSavedRepos()).toContain(key)
    expect(getRemoteRepoConfig(key)).not.toBeNull()
    const r = removeSavedRepo(key)
    expect(r.removed).toBe(true)
    expect(getSavedRepos()).not.toContain(key)
    expect(getRemoteRepoConfig(key)).toBeNull()
  })
})
