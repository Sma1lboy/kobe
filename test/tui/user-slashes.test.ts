/**
 * Unit tests for the user slash-command loader
 * (`src/tui/panes/chat/composer/user-slashes.ts`).
 *
 * Why these tests matter:
 *   - The loader scans the user's real `~/.claude/{commands,skills}` on
 *     every keystroke that opens the slash dropdown. A regression here
 *     means the dropdown silently drops a user's custom commands or, worse,
 *     crashes the composer when a malformed file is encountered. Both
 *     failures degrade the product to "feels like a third-party shell"
 *     rather than "feels like Claude Code".
 *   - `extractDescription` is the only module-private bit of YAML parsing
 *     we maintain. We intentionally do NOT depend on a YAML library — see
 *     module doc comment for rationale — so we own correctness for the
 *     subset users actually hit. The block-scalar (`|` / `>`) case is the
 *     one that cost the dropdown in practice (autoplan SKILL.md returned a
 *     literal `|`). We test it directly and via the loader.
 *
 * Test isolation:
 *   - Each test gets a fresh tmpdir; we override HOME + pass an explicit
 *     worktreePath. We restore HOME in `afterEach`.
 *   - The symlink case mirrors a real skill from Jackson's machine
 *     (`~/.claude/skills/autoplan -> .../gstack/autoplan`). The loader
 *     must follow symlinked skill folders or it will silently miss them.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { extractDescription, loadUserSlashes } from "@/tui/panes/chat/composer/user-slashes"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

// ---------------------------------------------------------------------------
// Tmpdir scaffolding — each test gets a fresh root with a fake $HOME and a
// fake worktree, both inside the same tmp tree so cleanup is one rmSync.
// ---------------------------------------------------------------------------

let tmpRoot: string
let fakeHome: string
let fakeWorktree: string
let savedHome: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-userslashes-"))
  fakeHome = path.join(tmpRoot, "home")
  fakeWorktree = path.join(tmpRoot, "worktree")
  fs.mkdirSync(fakeHome, { recursive: true })
  fs.mkdirSync(fakeWorktree, { recursive: true })
  savedHome = process.env.HOME
  process.env.HOME = fakeHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: test cleanup needs the env key fully removed (assigning undefined leaves it as the string "undefined").
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function writeCommand(base: string, name: string, body: string): void {
  const dir = path.join(base, ".claude", "commands")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), body)
}

function writeSkill(base: string, name: string, body: string): string {
  const dir = path.join(base, ".claude", "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  const skillMd = path.join(dir, "SKILL.md")
  fs.writeFileSync(skillMd, body)
  return dir
}

// ---------------------------------------------------------------------------
// extractDescription — pure helper, no fs.
// ---------------------------------------------------------------------------

describe("extractDescription", () => {
  test("returns null when there is no frontmatter at all", () => {
    expect(extractDescription("just a body, no front matter")).toBeNull()
  })

  test("returns null when frontmatter never closes", () => {
    expect(extractDescription("---\nname: foo\n")).toBeNull()
  })

  test("returns null when frontmatter is empty", () => {
    expect(extractDescription("---\n---\nbody")).toBeNull()
  })

  test("returns null when no description: key is present", () => {
    expect(extractDescription("---\nname: foo\nversion: 1\n---\nbody")).toBeNull()
  })

  test("parses single-line description (matches vibe-kanban behavior)", () => {
    const md = "---\nname: deploy\ndescription: Deploy to production\n---\nbody"
    expect(extractDescription(md)).toBe("Deploy to production")
  })

  test("trims surrounding whitespace from a single-line description", () => {
    const md = "---\ndescription:    spaced out   \n---\n"
    expect(extractDescription(md)).toBe("spaced out")
  })

  test("supports block scalar | (literal newlines preserved)", () => {
    const md = ["---", "description: |", "  hello", "  world", "---", "body"].join("\n")
    expect(extractDescription(md)).toBe("hello\nworld")
  })

  test("supports block scalar > (newlines folded to spaces)", () => {
    const md = ["---", "description: >", "  hello", "  world", "---", "body"].join("\n")
    expect(extractDescription(md)).toBe("hello world")
  })

  test("block scalar | stops at next top-level key (dedent)", () => {
    const md = [
      "---",
      "name: autoplan",
      "description: |",
      "  Auto-review pipeline — reads the full CEO, design, eng, and DX review skills",
      "  and runs them sequentially with auto-decisions.",
      "benefits-from: [office-hours]",
      "---",
      "body",
    ].join("\n")
    const got = extractDescription(md)
    expect(got).toBe(
      "Auto-review pipeline — reads the full CEO, design, eng, and DX review skills\nand runs them sequentially with auto-decisions.",
    )
  })

  test("block scalar handles empty lines inside the block (literal | mode)", () => {
    const md = ["---", "description: |", "  para one", "", "  para two", "---", ""].join("\n")
    expect(extractDescription(md)).toBe("para one\n\npara two")
  })
})

// ---------------------------------------------------------------------------
// loadUserSlashes — fs-backed.
// ---------------------------------------------------------------------------

describe("loadUserSlashes", () => {
  test("does not crash when neither $HOME/.claude nor worktree/.claude exist", async () => {
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([])
  })

  test("finds a global command with a single-line description", async () => {
    writeCommand(fakeHome, "deploy", "---\ndescription: Ship to prod\n---\nbody")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "deploy", description: "Ship to prod" }])
  })

  test("registers files with empty frontmatter using '' description", async () => {
    writeCommand(fakeHome, "noop", "---\n---\nbody")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "noop", description: "" }])
  })

  test("registers files with no description: key using '' description", async () => {
    writeCommand(fakeHome, "namedonly", "---\nname: foo\nversion: 1\n---\nbody")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "namedonly", description: "" }])
  })

  test("merges global + project, sorted by name", async () => {
    writeCommand(fakeHome, "deploy", "---\ndescription: global deploy\n---\n")
    writeCommand(fakeWorktree, "build", "---\ndescription: project build\n---\n")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([
      { name: "build", description: "project build" },
      { name: "deploy", description: "global deploy" },
    ])
  })

  test("project shadows global on name collision", async () => {
    writeCommand(fakeHome, "deploy", "---\ndescription: global deploy\n---\n")
    writeCommand(fakeWorktree, "deploy", "---\ndescription: project deploy\n---\n")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "deploy", description: "project deploy" }])
  })

  test("loads a skill via SKILL.md and folds a multi-line block scalar (autoplan-style)", async () => {
    const body = [
      "---",
      "name: autoplan",
      "description: |",
      "  Auto-review pipeline — reads the full CEO, design, eng, and DX review skills",
      "  and runs them sequentially with auto-decisions using 6 decision principles.",
      "---",
      "body",
    ].join("\n")
    writeSkill(fakeHome, "autoplan", body)
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("autoplan")
    expect(out[0].description).toBe(
      "Auto-review pipeline — reads the full CEO, design, eng, and DX review skills\nand runs them sequentially with auto-decisions using 6 decision principles.",
    )
  })

  test("follows a symlinked skill folder (real-user case: ~/.claude/skills/autoplan -> gstack/autoplan)", async () => {
    // Real skill folder lives under a sibling path, then symlinked into
    // .claude/skills/. Mirrors how gstack-shipped skills are wired on
    // Jackson's machine.
    const realSkillRoot = path.join(tmpRoot, "real-skills", "autoplan")
    fs.mkdirSync(realSkillRoot, { recursive: true })
    fs.writeFileSync(
      path.join(realSkillRoot, "SKILL.md"),
      ["---", "description: linked skill", "---", "body"].join("\n"),
    )
    const skillsDir = path.join(fakeHome, ".claude", "skills")
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.symlinkSync(realSkillRoot, path.join(skillsDir, "autoplan"))

    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "autoplan", description: "linked skill" }])
  })

  test("does not crash when only the commands dir exists (no skills dir)", async () => {
    writeCommand(fakeHome, "x", "---\ndescription: x\n---\n")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "x", description: "x" }])
  })

  test("does not crash when only the skills dir exists (no commands dir)", async () => {
    writeSkill(fakeHome, "y", "---\ndescription: y\n---\n")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "y", description: "y" }])
  })

  test("ignores non-.md files in commands/", async () => {
    writeCommand(fakeHome, "good", "---\ndescription: ok\n---\n")
    fs.writeFileSync(path.join(fakeHome, ".claude", "commands", "README.txt"), "ignore me")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([{ name: "good", description: "ok" }])
  })

  test("ignores skill folders without SKILL.md", async () => {
    const dir = path.join(fakeHome, ".claude", "skills", "incomplete")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "notes.md"), "no frontmatter here")
    const out = await loadUserSlashes(fakeWorktree)
    expect(out).toEqual([])
  })

  test("works with no worktreePath argument (global-only)", async () => {
    writeCommand(fakeHome, "g", "---\ndescription: global only\n---\n")
    const out = await loadUserSlashes(undefined)
    expect(out).toEqual([{ name: "g", description: "global only" }])
  })
})
