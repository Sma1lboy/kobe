import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { buildPRPrompt, gatherPRPromptState, renderPRPrompt } from "../../src/tui/ops/pr-prompt"

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
