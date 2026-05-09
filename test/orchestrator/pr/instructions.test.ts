/**
 * Unit tests for the PR-instructions template + render + load helpers.
 *
 * Covers:
 *   - renderPRInstructions: substitution for each combination of
 *     dirtyCount (0/1/2) and hasUpstream (true/false). Asserts both that
 *     the substituted strings appear AND that no `{{...}}` markers leak.
 *   - Unknown placeholders are left literal (we never throw).
 *   - loadPRInstructionsTemplate: returns the default when the override
 *     file is missing; returns the file contents when present (incl.
 *     contents bypassing all substitution).
 */

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  DEFAULT_PR_INSTRUCTIONS_TEMPLATE,
  type PRState,
  loadPRInstructionsTemplate,
  renderPRInstructions,
} from "../../../src/orchestrator/pr/instructions.ts"

function st(over: Partial<PRState> = {}): PRState {
  return {
    branch: "feature/x",
    targetBranch: "main",
    hasUpstream: false,
    dirtyCount: 0,
    ...over,
  }
}

describe("renderPRInstructions", () => {
  test("substitutes branch + targetBranch", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ branch: "feat/foo", targetBranch: "dev" }))
    expect(out).toContain("The current branch is feat/foo.")
    expect(out).toContain("The target branch is dev.")
    // gh command uses the target branch.
    expect(out).toContain("gh pr create --base dev")
  })

  test("dirty count = 0 → 'no uncommitted changes'", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ dirtyCount: 0 }))
    expect(out).toContain("There are no uncommitted changes.")
    expect(out).not.toContain("There is 1")
    expect(out).not.toContain("There are 0 uncommitted")
  })

  test("dirty count = 1 → singular sentence", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ dirtyCount: 1 }))
    expect(out).toContain("There is 1 uncommitted change.")
    expect(out).not.toContain("There are 1")
  })

  test("dirty count = 2 → plural sentence with the number", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ dirtyCount: 2 }))
    expect(out).toContain("There are 2 uncommitted changes.")
  })

  test("hasUpstream true → tracks-an-upstream sentence", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ hasUpstream: true }))
    expect(out).toContain("The current branch tracks an upstream.")
    expect(out).not.toContain("There is no upstream branch yet.")
  })

  test("hasUpstream false → no-upstream-yet sentence", () => {
    const out = renderPRInstructions(DEFAULT_PR_INSTRUCTIONS_TEMPLATE, st({ hasUpstream: false }))
    expect(out).toContain("There is no upstream branch yet.")
    expect(out).not.toContain("The current branch tracks an upstream.")
  })

  test("never leaks unsubstituted {{branch}} / {{targetBranch}} / {{dirtyCountSentence}} / {{upstreamSentence}}", () => {
    for (const dirty of [0, 1, 5]) {
      for (const upstream of [true, false]) {
        const out = renderPRInstructions(
          DEFAULT_PR_INSTRUCTIONS_TEMPLATE,
          st({ dirtyCount: dirty, hasUpstream: upstream }),
        )
        expect(out).not.toContain("{{branch}}")
        expect(out).not.toContain("{{targetBranch}}")
        expect(out).not.toContain("{{dirtyCountSentence}}")
        expect(out).not.toContain("{{upstreamSentence}}")
      }
    }
  })

  test("unknown placeholders are left literal (never throws)", () => {
    const tpl = "branch={{branch}}, weird={{somethingNew}}, end"
    const out = renderPRInstructions(tpl, st({ branch: "main" }))
    expect(out).toBe("branch=main, weird={{somethingNew}}, end")
  })
})

describe("loadPRInstructionsTemplate", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-instr-"))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test("returns the default template when no override file exists", async () => {
    const out = await loadPRInstructionsTemplate(tmp)
    expect(out).toBe(DEFAULT_PR_INSTRUCTIONS_TEMPLATE)
  })

  test("returns the override file contents when .kobe/pr-instructions.md exists", async () => {
    const override = "Custom instructions: {{branch}} only.\n"
    await fs.mkdir(path.join(tmp, ".kobe"), { recursive: true })
    await fs.writeFile(path.join(tmp, ".kobe", "pr-instructions.md"), override, "utf8")
    const out = await loadPRInstructionsTemplate(tmp)
    expect(out).toBe(override)
  })

  test("returns the default when the override file is empty", async () => {
    await fs.mkdir(path.join(tmp, ".kobe"), { recursive: true })
    await fs.writeFile(path.join(tmp, ".kobe", "pr-instructions.md"), "", "utf8")
    const out = await loadPRInstructionsTemplate(tmp)
    expect(out).toBe(DEFAULT_PR_INSTRUCTIONS_TEMPLATE)
  })

  test("returns the default for an empty/falsy worktree path (defensive)", async () => {
    const out = await loadPRInstructionsTemplate("")
    expect(out).toBe(DEFAULT_PR_INSTRUCTIONS_TEMPLATE)
  })
})
