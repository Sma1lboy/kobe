/**
 * Unit tests for the per-repo init resolution (state/repo-init.ts) and the
 * state.json override accessors (state/repos.ts).
 *
 * Priority is the load-bearing rule: in-repo `.kobe/` files WIN over the
 * per-user state.json override, resolved PER FIELD. The override is the
 * fallback default. Paths used here are plain tmpdirs (not git repos), so
 * `resolveRepoRoot` returns them verbatim — no git shelling, deterministic.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { resolveRepoInit } from "../../src/state/repo-init.ts"
import { getRepoInitOverride, setRepoInitOverride } from "../../src/state/repos.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-repoinit-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test.
  if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function makeWorktree(files: Record<string, string> = {}): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-wt-"))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(wt, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, "utf8")
  }
  return wt
}

describe("repo init override (state.json)", () => {
  test("round-trips set → get", () => {
    setRepoInitOverride("/repo/x", { initScript: "pnpm i", initPrompt: "read CLAUDE.md" })
    expect(getRepoInitOverride("/repo/x")).toEqual({ initScript: "pnpm i", initPrompt: "read CLAUDE.md" })
  })

  test("patches one field without dropping the other", () => {
    setRepoInitOverride("/repo/x", { initScript: "a", initPrompt: "b" })
    setRepoInitOverride("/repo/x", { initPrompt: "b2" })
    expect(getRepoInitOverride("/repo/x")).toEqual({ initScript: "a", initPrompt: "b2" })
  })

  test("empty string clears a field; clearing both drops the entry", () => {
    setRepoInitOverride("/repo/x", { initScript: "a", initPrompt: "b" })
    setRepoInitOverride("/repo/x", { initScript: "" })
    expect(getRepoInitOverride("/repo/x")).toEqual({ initPrompt: "b" })
    setRepoInitOverride("/repo/x", { initPrompt: "" })
    expect(getRepoInitOverride("/repo/x")).toEqual({})
  })

  test("absent repo → empty override", () => {
    expect(getRepoInitOverride("/never/set")).toEqual({})
  })
})

describe("resolveRepoInit (files win over override, per field)", () => {
  test("no files, no override → nothing", () => {
    const wt = makeWorktree()
    expect(resolveRepoInit(wt, wt)).toEqual({})
  })

  test("override is the fallback when the repo ships no .kobe files", () => {
    const wt = makeWorktree()
    setRepoInitOverride(wt, { initScript: "make setup", initPrompt: "hi" })
    expect(resolveRepoInit(wt, wt)).toEqual({ initScript: "make setup", initPrompt: "hi" })
  })

  test("repo .kobe/init.sh + init-prompt.md WIN over the override", () => {
    const wt = makeWorktree({
      ".kobe/init.sh": "echo hi",
      ".kobe/init-prompt.md": "start by reading the docs",
    })
    setRepoInitOverride(wt, { initScript: "make setup", initPrompt: "ignored" })
    const r = resolveRepoInit(wt, wt)
    // script runs the committed file by relative path (cwd is the worktree)
    expect(r.initScript).toBe("sh .kobe/init.sh")
    expect(r.initPrompt).toBe("start by reading the docs")
  })

  test("per field: file script wins, override prompt fills the gap", () => {
    const wt = makeWorktree({ ".kobe/init.sh": "echo hi" })
    setRepoInitOverride(wt, { initScript: "ignored", initPrompt: "from override" })
    expect(resolveRepoInit(wt, wt)).toEqual({ initScript: "sh .kobe/init.sh", initPrompt: "from override" })
  })

  test("a blank init-prompt.md is treated as absent (falls back)", () => {
    const wt = makeWorktree({ ".kobe/init-prompt.md": "   \n  " })
    setRepoInitOverride(wt, { initPrompt: "fallback" })
    expect(resolveRepoInit(wt, wt).initPrompt).toBe("fallback")
  })
})
