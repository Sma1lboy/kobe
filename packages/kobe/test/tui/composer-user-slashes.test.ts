/**
 * Unit tests for the user slash-command loader at
 * `src/tui/chat/composer/user-slashes.ts`.
 *
 * `extractDescription` is a pure frontmatter parser; `loadUserSlashes`
 * scans `.claude/{commands,skills}` under a worktree + the user home.
 * We isolate the home scan via `process.env.HOME` (the loader's
 * `resolveHome` honours it before `os.homedir()`), and use tmp dirs so
 * the real `~/.claude/` is never read.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { extractDescription, loadUserSlashes } from "../../src/tui/chat/composer/user-slashes"

describe("extractDescription", () => {
  test("returns null without frontmatter", () => {
    expect(extractDescription("no frontmatter here")).toBeNull()
  })

  test("returns null when the frontmatter never closes", () => {
    expect(extractDescription("---\ndescription: x\n")).toBeNull()
  })

  test("returns null when there is no description key", () => {
    expect(extractDescription("---\nname: foo\n---\nbody")).toBeNull()
  })

  test("reads a plain scalar description", () => {
    expect(extractDescription("---\ndescription: A one-liner\n---\nbody")).toBe("A one-liner")
  })

  test("folds a `>` block scalar into a single line", () => {
    const md = "---\ndescription: >\n  first line\n  second line\n---\nbody"
    expect(extractDescription(md)).toBe("first line second line")
  })

  test("keeps `|` block scalar newlines", () => {
    const md = "---\ndescription: |\n  line one\n  line two\n---\nbody"
    expect(extractDescription(md)).toBe("line one\nline two")
  })
})

describe("loadUserSlashes", () => {
  let home: string
  let worktree: string
  const origHome = process.env.HOME

  function writeCmd(root: string, name: string, description: string): void {
    const dir = join(root, ".claude", "commands")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\nprompt`)
  }
  function writeSkill(root: string, name: string, description: string): void {
    const dir = join(root, ".claude", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `---\ndescription: ${description}\n---\nprompt`)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kobe-home-"))
    worktree = mkdtempSync(join(tmpdir(), "kobe-wt-"))
    process.env.HOME = home
  })
  afterEach(() => {
    if (origHome === undefined) Reflect.deleteProperty(process.env, "HOME")
    else process.env.HOME = origHome
    rmSync(home, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  test("collects commands + skills from home, sorted by name", async () => {
    writeCmd(home, "deploy", "ship it")
    writeSkill(home, "review", "review it")
    const out = await loadUserSlashes()
    expect(out.map((e) => e.name)).toEqual(["deploy", "review"])
    expect(out.find((e) => e.name === "deploy")?.description).toBe("ship it")
  })

  test("project entries win over home on name collision", async () => {
    writeCmd(home, "deploy", "global deploy")
    writeCmd(worktree, "deploy", "project deploy")
    const out = await loadUserSlashes(worktree)
    const deploy = out.filter((e) => e.name === "deploy")
    expect(deploy).toHaveLength(1)
    expect(deploy[0]?.description).toBe("project deploy")
  })

  test("empty when nothing is present", async () => {
    expect(await loadUserSlashes(worktree)).toEqual([])
  })
})
