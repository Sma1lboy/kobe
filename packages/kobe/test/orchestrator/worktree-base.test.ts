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

  test("expands a leading $project_dir against the project root, collapsing ..", () => {
    expect(normalizeWorktreeBase("$project_dir", repo)).toBe(repo)
    expect(normalizeWorktreeBase("$project_dir/wt", repo)).toBe(path.join(repo, "wt"))
    expect(normalizeWorktreeBase("$project_dir/../wt", repo)).toBe(path.resolve(repo, "../wt"))
    expect(normalizeWorktreeBase("$project_dir/../", repo)).toBe(path.dirname(repo))
  })

  test("$project_dir without a project context falls back to null (default root)", () => {
    expect(normalizeWorktreeBase("$project_dir/../wt")).toBeNull()
  })

  test("a non-leading $project_dir is a literal path segment, not a token", () => {
    const literal = path.join(tmpRoot, "x/$project_dir")
    expect(normalizeWorktreeBase(literal, repo)).toBe(literal)
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

  test("$project_dir override → root resolved per project, per-repo subdir kept", () => {
    writeState({ "worktree.basePath": "$project_dir/../kobe-wt" })

    const root = worktreeRootFor(repo)
    expect(path.dirname(root)).toBe(path.resolve(repo, "../kobe-wt"))
    expect(path.basename(root)).toMatch(/^repo-[0-9a-f]{12}$/)

    // A second repo in another parent dir gets its own resolved base.
    const otherRepo = path.join(tmpRoot, "nested", "other")
    fs.mkdirSync(otherRepo, { recursive: true })
    expect(path.dirname(worktreeRootFor(otherRepo))).toBe(path.resolve(otherRepo, "../kobe-wt"))

    // The default root stays recognized so pre-override tasks keep listing.
    const roots = managedWorktreeRootsFor(repo)
    expect(roots[0]).toBe(root)
    expect(roots).toContain(path.join(home, ".kobe", "worktrees", path.basename(root)))
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
