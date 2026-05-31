import { describe, expect, it } from "vitest"
import { topLevelUsage } from "../../src/cli/usage.ts"
import { CURRENT_VERSION } from "../../src/version.ts"

describe("topLevelUsage", () => {
  const usage = topLevelUsage()

  it("shows the current version in the header", () => {
    expect(usage).toContain(`kobe ${CURRENT_VERSION}`)
  })

  it("lists every public subcommand, including api", () => {
    for (const cmd of ["add", "adopt", "repo", "api", "daemon", "theme", "update", "doctor", "reset"]) {
      expect(usage).toContain(cmd)
    }
  })

  it("documents the help and version flags", () => {
    expect(usage).toContain("--help")
    expect(usage).toContain("--version")
  })

  it("explains the bare-kobe TUI default", () => {
    expect(usage.toLowerCase()).toContain("launch the tui")
  })
})
