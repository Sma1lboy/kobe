/**
 * Unit tests for the configurable worktree base path
 * (`src/state/worktree-prefs.ts`) and its effect on the canonical worktree
 * layout (`src/orchestrator/worktree/paths.ts`).
 *
 * Like the other state tests, HOME is redirected via `KOBE_HOME_DIR` to a
 * per-test tmpdir so every state.json read/write is scoped there and the
 * real `~/.config/kobe/` is untouched. The setting is the TUI-written
 * `worktree.basePath` key; the daemon reads it here through the same blob.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  defaultWorktreesBaseDir,
  managedWorktreeRootsFor,
  worktreeRootFor,
  worktreesBaseDir,
} from "../../src/orchestrator/worktree/paths.ts"
import { patchStateFile } from "../../src/state/store.ts"
import {
  WORKTREE_BASE_PATH_KEY,
  getConfiguredWorktreeBase,
  isValidWorktreeBasePath,
  normalizeWorktreeBasePath,
} from "../../src/state/worktree-prefs.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-wtprefs-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test.
  if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function setBasePath(value: string): void {
  patchStateFile({ [WORKTREE_BASE_PATH_KEY]: value })
}

describe("normalizeWorktreeBasePath", () => {
  test("blank / whitespace / non-string → undefined (means default)", () => {
    expect(normalizeWorktreeBasePath("")).toBeUndefined()
    expect(normalizeWorktreeBasePath("   ")).toBeUndefined()
    expect(normalizeWorktreeBasePath(undefined)).toBeUndefined()
    expect(normalizeWorktreeBasePath(42)).toBeUndefined()
  })

  test("relative path → undefined (never roots worktrees somewhere ambiguous)", () => {
    expect(normalizeWorktreeBasePath("worktrees")).toBeUndefined()
    expect(normalizeWorktreeBasePath("./wt")).toBeUndefined()
    expect(normalizeWorktreeBasePath("../wt")).toBeUndefined()
  })

  test("absolute path → trimmed + normalized", () => {
    expect(normalizeWorktreeBasePath("  /srv/wt  ")).toBe("/srv/wt")
    expect(normalizeWorktreeBasePath("/srv/wt/")).toBe("/srv/wt")
    expect(normalizeWorktreeBasePath("/srv/./a/../wt")).toBe("/srv/wt")
  })

  test("leading ~ expands to KOBE_HOME_DIR", () => {
    expect(normalizeWorktreeBasePath("~")).toBe(tmpHome)
    expect(normalizeWorktreeBasePath("~/code/wt")).toBe(path.join(tmpHome, "code/wt"))
  })
})

describe("isValidWorktreeBasePath", () => {
  test("blank is valid (means default); absolute is valid; relative is not", () => {
    expect(isValidWorktreeBasePath("")).toBe(true)
    expect(isValidWorktreeBasePath("   ")).toBe(true)
    expect(isValidWorktreeBasePath("~/wt")).toBe(true)
    expect(isValidWorktreeBasePath("/abs/wt")).toBe(true)
    expect(isValidWorktreeBasePath("relative/wt")).toBe(false)
  })
})

describe("getConfiguredWorktreeBase", () => {
  test("undefined when the key is unset", () => {
    expect(getConfiguredWorktreeBase()).toBeUndefined()
  })

  test("reads + normalizes the stored value", () => {
    setBasePath("~/elsewhere")
    expect(getConfiguredWorktreeBase()).toBe(path.join(tmpHome, "elsewhere"))
  })

  test("a relative (invalid) stored value falls back to undefined", () => {
    setBasePath("not/absolute")
    expect(getConfiguredWorktreeBase()).toBeUndefined()
  })
})

describe("worktreesBaseDir / worktreeRootFor", () => {
  const repo = "/Users/x/proj"

  test("defaults under <kobeStateDir>/worktrees when unset", () => {
    expect(worktreesBaseDir()).toBe(defaultWorktreesBaseDir())
    expect(defaultWorktreesBaseDir()).toBe(path.join(tmpHome, ".kobe", "worktrees"))
    expect(worktreeRootFor(repo).startsWith(path.join(tmpHome, ".kobe", "worktrees"))).toBe(true)
  })

  test("an override relocates the base while keeping the per-repo subdir name", () => {
    // The per-repo dir name depends only on the repo, so it is stable across bases.
    const repoDirName = path.basename(worktreeRootFor(repo))
    setBasePath("/srv/worktrees")
    expect(worktreesBaseDir()).toBe("/srv/worktrees")
    const root = worktreeRootFor(repo)
    expect(path.dirname(root)).toBe("/srv/worktrees")
    expect(path.basename(root)).toBe(repoDirName)
  })
})

describe("managedWorktreeRootsFor", () => {
  const repo = "/Users/x/proj"

  test("no duplicate built-in root when the base is unset", () => {
    const roots = managedWorktreeRootsFor(repo)
    // primary == built-in default, so it appears exactly once (then repo-local legacy roots)
    const primary = worktreeRootFor(repo)
    expect(roots[0]).toBe(primary)
    expect(roots.filter((r) => r === primary)).toHaveLength(1)
  })

  test("keeps the built-in default as a recognized legacy root when overridden", () => {
    const repoDirName = path.basename(worktreeRootFor(repo)) // computed while unset
    setBasePath("/srv/worktrees")
    const roots = managedWorktreeRootsFor(repo)
    const builtin = path.join(defaultWorktreesBaseDir(), repoDirName)
    expect(roots[0]).toBe(worktreeRootFor(repo)) // primary = new base
    expect(roots).toContain(builtin) // old worktrees stay discoverable
    // repo-local compat roots still present
    expect(roots.some((r) => r === path.join(repo, ".kobe/worktrees"))).toBe(true)
  })
})
