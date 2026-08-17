import { describe, expect, it } from "vitest"
import { deriveConventionBranch, inferBranchStyle, uniqueBranchName } from "../../src/orchestrator/branch-style.ts"

describe("inferBranchStyle", () => {
  it("reads an all-feat/ repo as typed with feat as the default prefix", () => {
    const style = inferBranchStyle(["main", "feat/login", "feat/signup", "feat/billing"])
    expect(style).toEqual({ kind: "typed", defaultPrefix: "feat" })
  })

  it("picks the DOMINANT prefix in a mixed typed repo", () => {
    const style = inferBranchStyle(["main", "fix/a", "fix/b", "fix/c", "feat/x", "chore/deps"])
    expect(style).toEqual({ kind: "typed", defaultPrefix: "fix" })
  })

  it("reads a bare-kebab repo as bare", () => {
    expect(inferBranchStyle(["main", "login-flow", "signup-page", "billing-refactor"])).toEqual({ kind: "bare" })
  })

  it("falls back to bare for an empty repo (no branches)", () => {
    expect(inferBranchStyle([])).toEqual({ kind: "bare" })
  })

  it("ignores non-conventional prefixes (user/, backup/, legacy rove/)", () => {
    // None of these vote; only `main` votes bare → bare.
    expect(inferBranchStyle(["main", "alice/spike", "backup/old", "rove/task-abc123"])).toEqual({ kind: "bare" })
  })

  it("breaks a typed-vs-bare tie toward typed (main always votes bare)", () => {
    expect(inferBranchStyle(["main", "feat/x"])).toEqual({ kind: "typed", defaultPrefix: "feat" })
  })
})

describe("deriveConventionBranch", () => {
  const typed = { kind: "typed", defaultPrefix: "feat" } as const
  const bare = { kind: "bare" } as const

  it("applies the repo's default prefix in a typed repo", () => {
    expect(deriveConventionBranch("Add login flow", typed)).toBe("feat/add-login-flow")
  })

  it("lifts a leading type word out of the title as the prefix", () => {
    expect(deriveConventionBranch("Fix login flow", typed)).toBe("fix/login-flow")
    expect(deriveConventionBranch("docs update quickstart", typed)).toBe("docs/update-quickstart")
  })

  it("emits a bare kebab slug in a bare repo", () => {
    expect(deriveConventionBranch("Fix login flow", bare)).toBe("fix-login-flow")
  })

  it("NEVER contains rove/kobe brand tokens", () => {
    for (const style of [typed, bare]) {
      const branch = deriveConventionBranch("rove kobe integration for Rove", style)
      expect(branch).not.toMatch(/rove|kobe/)
    }
  })

  it("falls back to 'task' when the title has no slug-able chars", () => {
    expect(deriveConventionBranch("!!!", bare)).toBe("task")
    expect(deriveConventionBranch("", typed)).toBe("feat/task")
  })

  it("caps the slug at 32 chars without a trailing hyphen", () => {
    const branch = deriveConventionBranch("fix the very long feature name that exceeds the cap", typed)
    const slug = branch.slice("fix/".length)
    expect(slug.length).toBeLessThanOrEqual(32)
    expect(slug.endsWith("-")).toBe(false)
    expect(branch).not.toContain("--")
  })
})

describe("uniqueBranchName", () => {
  it("returns the base when free", () => {
    expect(uniqueBranchName("feat/login", new Set(["main"]), "01HXABCDEF")).toBe("feat/login")
  })

  it("appends -2 / -3 short suffixes on collision", () => {
    expect(uniqueBranchName("feat/login", new Set(["feat/login"]), "01HXABCDEF")).toBe("feat/login-2")
    expect(uniqueBranchName("feat/login", new Set(["feat/login", "feat/login-2"]), "01HXABCDEF")).toBe("feat/login-3")
  })

  it("falls back to a task-id suffix when -2…-99 are all taken", () => {
    const taken = new Set(["x", ...Array.from({ length: 98 }, (_, i) => `x-${i + 2}`)])
    expect(uniqueBranchName("x", taken, "01HXABCDEF")).toBe("x-abcdef")
  })
})
