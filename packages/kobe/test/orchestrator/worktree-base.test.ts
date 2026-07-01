/**
 * Unit tests for the global worktree base-path override.
 *
 * The override relocates the `<home>/.kobe/worktrees` root wholesale
 * while keeping the per-repo `<repo>-<hash>` subfolder. We assert both
 * the pure normalizer and its effect on the path helpers, plus that the
 * default root stays recognized (so worktrees created before the
 * override are still discoverable).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { managedWorktreeRootsFor, worktreeRootFor } from "../../src/orchestrator/worktree/paths.ts"
import { getWorktreeBaseOverride, normalizeWorktreeBase } from "../../src/state/worktree-base.ts"

let tmpRoot: string
let home: string
let repo: string
let prevHome: string | undefined

function writeState(obj: Record<string, unknown>): void {
  const p = path.join(home, ".config", "kobe", "state.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj), "utf8")
}

beforeEach(() => {
  prevHome = process.env.KOBE_HOME_DIR
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-wt-base-"))
  home = path.join(tmpRoot, "home")
  process.env.KOBE_HOME_DIR = home
  repo = path.join(tmpRoot, "repo")
  fs.mkdirSync(repo, { recursive: true })
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

describe("normalizeWorktreeBase", () => {
  test("blank / non-string values fall back to null (use default)", () => {
    expect(normalizeWorktreeBase(undefined)).toBeNull()
    expect(normalizeWorktreeBase(null)).toBeNull()
    expect(normalizeWorktreeBase("")).toBeNull()
    expect(normalizeWorktreeBase("   ")).toBeNull()
  })

  test("expands a leading ~ against the kobe home", () => {
    expect(normalizeWorktreeBase("~")).toBe(home)
    expect(normalizeWorktreeBase("~/code/wt")).toBe(path.join(home, "code/wt"))
  })

  test("resolves a relative path against home; passes an absolute through", () => {
    expect(normalizeWorktreeBase("code/wt")).toBe(path.resolve(home, "code/wt"))
    const abs = path.join(tmpRoot, "elsewhere/worktrees")
    expect(normalizeWorktreeBase(abs)).toBe(abs)
    expect(normalizeWorktreeBase(`  ${abs}  `)).toBe(abs)
  })
})

describe("worktree paths honor the override", () => {
  test("unset override → default ~/.kobe/worktrees root", () => {
    expect(getWorktreeBaseOverride()).toBeNull()
    const root = worktreeRootFor(repo)
    expect(root.startsWith(path.join(home, ".kobe", "worktrees"))).toBe(true)
    // No override → only the default root (+ repo-local legacy roots).
    const roots = managedWorktreeRootsFor(repo)
    expect(roots[0]).toBe(root)
    // The default root is not duplicated as a separate fallback.
    expect(roots.filter((r) => r === root)).toHaveLength(1)
  })

  test("set override → worktrees re-rooted under it, per-repo subdir kept", () => {
    const base = path.join(tmpRoot, "custom-worktrees")
    writeState({ "worktree.basePath": base })

    expect(getWorktreeBaseOverride()).toBe(base)
    const root = worktreeRootFor(repo)
    expect(path.dirname(root)).toBe(base) // <base>/<repo>-<hash>
    expect(path.basename(root)).toMatch(/^repo-[0-9a-f]{12}$/)
  })

  test("with an override, the default root stays recognized for listing", () => {
    const base = path.join(tmpRoot, "custom-worktrees")
    writeState({ "worktree.basePath": base })

    const roots = managedWorktreeRootsFor(repo)
    const activeRoot = worktreeRootFor(repo)
    const defaultRoot = path.join(home, ".kobe", "worktrees", path.basename(activeRoot))
    expect(roots[0]).toBe(activeRoot)
    expect(roots).toContain(defaultRoot)
  })
})
