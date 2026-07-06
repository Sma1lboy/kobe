import { describe, expect, it } from "vitest"
import {
  dispatcherProtocol,
  noteFilingProtocol,
  statusReportProtocol,
  withDispatcherProtocol,
  withWorktreeProtocol,
  worktreeProtocol,
} from "../../src/engine/interactive-command.ts"

const on = () => true
const off = () => false

describe("withWorktreeProtocol", () => {
  it("appends the flag + status protocol for an enabled claude launch", () => {
    const argv = withWorktreeProtocol(["claude"], "claude", "t1", { status: on, notes: off })
    expect(argv.slice(0, 2)).toEqual(["claude", "--append-system-prompt"])
    expect(argv[2]).toContain("task t1")
    expect(argv[2]).toContain("api set-status --task-id t1 --status in_review")
    expect(argv[2]).not.toContain("api edit")
  })

  it("composes status + note filing into ONE injection when both switches are on", () => {
    const argv = withWorktreeProtocol(["claude"], "claude", "t1", { status: on, notes: on })
    expect(argv.filter((a) => a === "--append-system-prompt")).toHaveLength(1)
    expect(argv[2]).toContain("api set-status --task-id t1")
    expect(argv[2]).toContain("api note --task-id t1")
  })

  it("notes-only works without the status switch", () => {
    const argv = withWorktreeProtocol(["claude"], "claude", "t1", { status: off, notes: on })
    expect(argv[2]).toContain("api note --task-id t1")
    expect(argv[2]).not.toContain("set-status")
  })

  it("missing vendor defaults to claude (the withClaudeSessionId convention)", () => {
    expect(withWorktreeProtocol(["claude"], undefined, "t1", { status: on, notes: off })).toHaveLength(3)
  })

  it("leaves the argv alone when nothing is enabled, vendor isn't claude, or no task", () => {
    expect(withWorktreeProtocol(["claude"], "claude", "t1", { status: off, notes: off })).toEqual(["claude"])
    expect(withWorktreeProtocol(["codex"], "codex", "t1", { status: on, notes: on })).toEqual(["codex"])
    expect(withWorktreeProtocol(["claude"], "claude", undefined, { status: on, notes: on })).toEqual(["claude"])
  })

  it("never double-injects over a custom command that sets the flag", () => {
    const custom = ["claude", "--append-system-prompt", "user's own"]
    expect(withWorktreeProtocol(custom, "claude", "t1", { status: on, notes: on })).toEqual(custom)
    const customFile = ["claude", "--append-system-prompt-file", "/tmp/p.txt"]
    expect(withWorktreeProtocol(customFile, "claude", "t1", { status: on, notes: on })).toEqual(customFile)
  })
})

describe("statusReportProtocol", () => {
  it("bakes the task id into both the identity line and the command", () => {
    const text = statusReportProtocol("01HXABC")
    expect(text).toContain("as task 01HXABC")
    expect(text).toContain("--task-id 01HXABC --status in_review")
    expect(text).not.toContain("--status done")
  })

  it("the api prefix is injectable — packaged builds bake plain `kobe api`", () => {
    expect(statusReportProtocol("t9", "kobe api")).toContain("kobe api set-status --task-id t9")
    expect(noteFilingProtocol("t9", "kobe api")).toContain('kobe api note --task-id t9 --text "<one line')
    expect(dispatcherProtocol("m9", "kobe api")).toContain("kobe api dispatch --task-id <id>")
    expect(dispatcherProtocol("m9", "kobe api")).toContain("kobe api collect --repo .")
  })
})

describe("worktreeProtocol", () => {
  it("returns null when neither switch is on (no pointless injection)", () => {
    expect(worktreeProtocol("t1", "kobe api", { status: off, notes: off })).toBeNull()
  })
})

describe("withDispatcherProtocol", () => {
  it("appends the dispatcher protocol for an enabled claude main-session launch", () => {
    const argv = withDispatcherProtocol(["claude"], "claude", "m1", on)
    expect(argv.slice(0, 2)).toEqual(["claude", "--append-system-prompt"])
    expect(argv[2]).toContain("DISPATCHER")
    expect(argv[2]).toContain("task m1")
    expect(argv[2]).toContain("api dispatch --task-id <id>")
    expect(argv[2]).not.toContain("api send")
    expect(argv[2]).toContain("[KOBE FIELD NOTE]")
  })

  it("leaves the argv alone when disabled, vendor isn't claude, or no task", () => {
    expect(withDispatcherProtocol(["claude"], "claude", "m1", off)).toEqual(["claude"])
    expect(withDispatcherProtocol(["codex"], "codex", "m1", on)).toEqual(["codex"])
    expect(withDispatcherProtocol(["claude"], "claude", undefined, on)).toEqual(["claude"])
  })

  it("never double-injects over a custom command that sets the flag", () => {
    const custom = ["claude", "--append-system-prompt", "user's own"]
    expect(withDispatcherProtocol(custom, "claude", "m1", on)).toEqual(custom)
  })

  it("composes with the worktree protocol: mutually exclusive task ids → exactly one protocol", () => {
    const card = withDispatcherProtocol(
      withWorktreeProtocol(["claude"], "claude", "t1", { status: on, notes: on }),
      "claude",
      undefined,
      on,
    )
    expect(card.filter((a) => a === "--append-system-prompt")).toHaveLength(1)
    expect(card[2]).toContain("in_review")
    const main = withDispatcherProtocol(
      withWorktreeProtocol(["claude"], "claude", undefined, { status: on, notes: on }),
      "claude",
      "m1",
      on,
    )
    expect(main.filter((a) => a === "--append-system-prompt")).toHaveLength(1)
    expect(main[2]).toContain("DISPATCHER")
  })
})

describe("dispatcherProtocol", () => {
  it("routes knowledge only — no status writes, no conflict actions, no git", () => {
    const text = dispatcherProtocol("01HMAIN")
    expect(text).toContain("task 01HMAIN")
    expect(text).not.toContain("set-status")
    expect(text).toContain("Take no action on merge conflicts")
    expect(text).not.toContain("merge-tree")
    expect(text).not.toContain("git merge")
    expect(text).not.toContain("rebase")
    expect(text).toContain("Never relay a note back to its author")
  })
})
