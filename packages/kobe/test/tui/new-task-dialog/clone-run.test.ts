/**
 * `cloneRepo` + the collision-suffix loop of `findAvailableFolderName` —
 * the halves clone.test.ts leaves out. cloneRepo drives a REAL `git clone`
 * against a local fixture repo (a mocked spawn would prove nothing about
 * the exit-code/stderr contract the dialog renders); failure comes from a
 * guaranteed-invalid source path, with GIT_TERMINAL_PROMPT=0 keeping it
 * non-interactive.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { cloneRepo, findAvailableFolderName } from "../../../src/tui/component/new-task-dialog/clone.ts"

let root: string
let origin: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kobe-clone-run-"))
  origin = join(root, "origin")
  mkdirSync(origin)
  execSync("git init -q -b main && git commit -q --allow-empty -m init", {
    cwd: origin,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("cloneRepo", () => {
  test("clones a real repo and resolves ok with the target path", async () => {
    const target = join(root, "clone-ok")
    const progress: string[] = []
    const result = await cloneRepo(origin, target, (line) => progress.push(line))
    expect(result).toEqual({ ok: true, path: target })
    expect(existsSync(join(target, ".git"))).toBe(true)
  })

  test("a failing clone resolves ok:false with git's last stderr line — never throws", async () => {
    const target = join(root, "clone-fail")
    const result = await cloneRepo(join(root, "no-such-source"), target)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    expect(existsSync(target)).toBe(false)
  })
})

describe("findAvailableFolderName — collision suffixing", () => {
  test("suffixes -2, -3, … until a free slot", () => {
    const parent = join(root, "parent")
    mkdirSync(join(parent, "repo"), { recursive: true })
    mkdirSync(join(parent, "repo-2"))
    expect(findAvailableFolderName(parent, "repo")).toBe("repo-3")
  })

  test("returns base verbatim when the parent is a file, not a directory", () => {
    execSync(`touch ${JSON.stringify(join(root, "a-file"))}`)
    expect(findAvailableFolderName(join(root, "a-file"), "repo")).toBe("repo")
  })
})
