import { describe, expect, it } from "vitest"
import { statusReportProtocol, withStatusProtocol } from "../../src/engine/interactive-command.ts"

/**
 * Status self-report injection (web-kanban.md M5). Load-bearing: the
 * protocol rides `--append-system-prompt` ONLY for claude launches of a
 * known task with the opt-in flag on, and a custom command that already
 * sets the flag is never double-injected.
 */

const on = () => true
const off = () => false

describe("withStatusProtocol", () => {
  it("appends the flag + protocol for an enabled claude launch", () => {
    const argv = withStatusProtocol(["claude"], "claude", "t1", on)
    expect(argv.slice(0, 2)).toEqual(["claude", "--append-system-prompt"])
    expect(argv[2]).toContain("task t1")
    expect(argv[2]).toContain("kobe api edit set-status --task-id t1 --status in_review")
  })

  it("missing vendor defaults to claude (the withClaudeSessionId convention)", () => {
    expect(withStatusProtocol(["claude"], undefined, "t1", on)).toHaveLength(3)
  })

  it("leaves the argv alone when disabled, vendor isn't claude, or no task", () => {
    expect(withStatusProtocol(["claude"], "claude", "t1", off)).toEqual(["claude"])
    expect(withStatusProtocol(["codex"], "codex", "t1", on)).toEqual(["codex"])
    expect(withStatusProtocol(["claude"], "claude", undefined, on)).toEqual(["claude"])
  })

  it("never double-injects over a custom command that sets the flag", () => {
    const custom = ["claude", "--append-system-prompt", "user's own"]
    expect(withStatusProtocol(custom, "claude", "t1", on)).toEqual(custom)
    const customFile = ["claude", "--append-system-prompt-file", "/tmp/p.txt"]
    expect(withStatusProtocol(customFile, "claude", "t1", on)).toEqual(customFile)
  })
})

describe("statusReportProtocol", () => {
  it("bakes the task id into both the identity line and the command", () => {
    const text = statusReportProtocol("01HXABC")
    expect(text).toContain("as task 01HXABC")
    expect(text).toContain("--task-id 01HXABC --status in_review")
    // The agent must never be told to set anything beyond in_review.
    expect(text).not.toContain("--status done")
  })
})
