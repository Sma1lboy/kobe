import { describe, expect, it } from "vitest"
import { TOP_LEVEL_SUBCOMMANDS } from "../../src/cli/subcommands.ts"
import { topLevelUsage } from "../../src/cli/usage.ts"
import { CURRENT_VERSION } from "../../src/version.ts"

/** The command names listed under the `Commands:` block of `kobe --help`. */
function usageCommandNames(usage: string): string[] {
  const lines = usage.split("\n")
  const start = lines.indexOf("Commands:")
  const end = lines.indexOf("Options:")
  return lines
    .slice(start + 1, end)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((name) => name.length > 0)
}

describe("topLevelUsage", () => {
  const usage = topLevelUsage()

  it("shows the current version in the header", () => {
    expect(usage).toContain(`kobe ${CURRENT_VERSION}`)
  })

  it("lists every public subcommand, including api", () => {
    for (const cmd of [
      "web",
      "add",
      "remove",
      "adopt",
      "repo",
      "api",
      "daemon",
      "theme",
      "skill",
      "update",
      "doctor",
      "reset",
      "reload",
    ]) {
      expect(usage).toContain(cmd)
    }
  })

  it("keeps TOP_LEVEL_SUBCOMMANDS in lock-step with the help text (completion drift guard)", () => {
    // `kobe completions` builds its scripts from TOP_LEVEL_SUBCOMMANDS; the help
    // text is the human-facing list. If they drift, completion silently stops
    // offering (or wrongly offers) a command. Assert the two are the same set.
    const help = [...usageCommandNames(usage)].sort()
    const completions = [...TOP_LEVEL_SUBCOMMANDS].sort()
    expect(completions).toEqual(help)
  })

  it("documents the help and version flags", () => {
    expect(usage).toContain("--help")
    expect(usage).toContain("--version")
  })

  it("explains the bare-kobe TUI default", () => {
    expect(usage.toLowerCase()).toContain("launch the tui")
  })
})
