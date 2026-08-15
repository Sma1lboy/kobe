import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { type PRPromptState, buildPRPrompt, gatherPRPromptState, renderPRPrompt } from "../../src/tui/ops/pr-prompt"

/** Pinned git state, so the override tests assert only template selection. */
const STATE: PRPromptState = { branch: "feature/x", targetBranch: "main", hasUpstream: false, dirtyCount: 0 }

describe("renderPRPrompt", () => {
  test("renders the built-in git state placeholders", () => {
    const text = renderPRPrompt("{{dirtyCountSentence}} {{branch}} -> {{targetBranch}}. {{upstreamSentence}}", {
      branch: "feature/x",
      targetBranch: "main",
      hasUpstream: false,
      dirtyCount: 2,
    })
    expect(text).toBe("There are 2 uncommitted changes. feature/x -> main. There is no upstream branch yet.")
  })

  test("leaves unknown placeholders literal for user templates", () => {
    const text = renderPRPrompt("{{branch}} {{unknownThing}}", {
      branch: "feature/x",
      targetBranch: "main",
      hasUpstream: true,
      dirtyCount: 0,
    })
    expect(text).toBe("feature/x {{unknownThing}}")
  })
})

// The git gathering went ASYNC (render-path rule: the Ops pane must not
// spawnSync — a huge repo's `git status` blocked the pane until timeout).
// These pin the async path against a real repo and the never-throw
// fallbacks against a missing one.
describe("buildPRPrompt (async git)", () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "kobe-pr-prompt-"))
    execFileSync("git", ["init", "-q", "-b", "feature/x"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], {
      cwd: dir,
    })
    return dir
  }

  test("gathers branch / target / upstream / dirty state without blocking", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "a.txt"), "hello")
    const text = await buildPRPrompt(repo)
    expect(text).toContain("The current branch is feature/x.")
    expect(text).toContain("The target branch is main.") // no origin/HEAD → fallback
    expect(text).toContain("There is 1 uncommitted change.")
    expect(text).toContain("There is no upstream branch yet.")
  })

  test("a missing worktree resolves to fallbacks instead of throwing", async () => {
    const state = await gatherPRPromptState(join(tmpdir(), "kobe-pr-prompt-definitely-missing"))
    expect(state).toEqual({ branch: "HEAD", targetBranch: "main", hasUpstream: false, dirtyCount: 0 })
  })
})

// The per-repo override moved to the canonical `.rove/` convention spelling
// (matching `.rove/init.sh`), with `.kobe/` kept as a fallback so repos that
// already committed one are not silently dropped back to the default.
describe("per-repo pr-instructions override", () => {
  function writeInstructions(dir: string, relDir: string, body: string): void {
    mkdirSync(join(dir, relDir), { recursive: true })
    writeFileSync(join(dir, relDir, "pr-instructions.md"), body)
  }

  test("reads the canonical .rove/pr-instructions.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rove-pr-instructions-"))
    writeInstructions(dir, ".rove", "canonical template for {{branch}}")
    await expect(buildPRPrompt(dir, STATE)).resolves.toBe("canonical template for feature/x")
  })

  test("falls back to the legacy .kobe/pr-instructions.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rove-pr-instructions-"))
    writeInstructions(dir, ".kobe", "legacy template for {{branch}}")
    await expect(buildPRPrompt(dir, STATE)).resolves.toBe("legacy template for feature/x")
  })

  test(".rove wins over .kobe when a repo carries both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rove-pr-instructions-"))
    writeInstructions(dir, ".kobe", "legacy")
    writeInstructions(dir, ".rove", "canonical")
    await expect(buildPRPrompt(dir, STATE)).resolves.toBe("canonical")
  })

  // An EMPTY canonical file is a placeholder, not "blank the prompt": it must
  // not shadow a real legacy template, and with nothing else it defaults.
  test("an empty .rove file does not shadow the legacy one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rove-pr-instructions-"))
    writeInstructions(dir, ".rove", "")
    writeInstructions(dir, ".kobe", "legacy")
    await expect(buildPRPrompt(dir, STATE)).resolves.toBe("legacy")
  })

  test("no override file falls back to the built-in template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rove-pr-instructions-"))
    await expect(buildPRPrompt(dir, STATE)).resolves.toContain("The user requested a PR.")
  })
})
