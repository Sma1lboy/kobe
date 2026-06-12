import { describe, expect, it } from "vitest"
import {
  dispatcherProtocol,
  statusReportProtocol,
  withDispatcherProtocol,
  withStatusProtocol,
} from "../../src/engine/interactive-command.ts"

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
    // `set-status` is a TOP-LEVEL api verb — `edit` is only a schema-doc
    // grouping label, not a command path (a real agent hit BAD_VERB on it).
    expect(argv[2]).toContain("api set-status --task-id t1 --status in_review")
    expect(argv[2]).not.toContain("api edit")
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

  it("the api prefix is injectable — packaged builds bake plain `kobe api`", () => {
    // The default resolves the environment's CLI invocation (the dev bun
    // line from a source checkout), so a protocol agent never drives a
    // stale global `kobe` that predates a new verb (BAD_VERB field bug).
    expect(statusReportProtocol("t9", "kobe api")).toContain("kobe api set-status --task-id t9")
    expect(dispatcherProtocol("m9", "kobe api")).toContain('kobe api dispatch --task-id <id> --prompt "<text>"')
    expect(dispatcherProtocol("m9", "kobe api")).toContain("kobe api collect --repo .")
  })
})

describe("withDispatcherProtocol", () => {
  it("appends the dispatcher protocol for an enabled claude main-session launch", () => {
    const argv = withDispatcherProtocol(["claude"], "claude", "m1", on)
    expect(argv.slice(0, 2)).toEqual(["claude", "--append-system-prompt"])
    expect(argv[2]).toContain("DISPATCHER")
    expect(argv[2]).toContain("task m1")
    // The messenger is the daemon-routed `dispatch`, NOT tmux-bound `send`
    // (web-hosted sessions would get a duplicate tmux twin otherwise).
    expect(argv[2]).toContain("api dispatch --task-id <id>")
    expect(argv[2]).not.toContain("api send")
    expect(argv[2]).toContain("[KOBE CONFLICT RADAR]")
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

  it("composes with withStatusProtocol: mutually exclusive task ids → exactly one protocol", () => {
    // A board card: status taskId set, dispatcher taskId undefined.
    const card = withDispatcherProtocol(withStatusProtocol(["claude"], "claude", "t1", on), "claude", undefined, on)
    expect(card.filter((a) => a === "--append-system-prompt")).toHaveLength(1)
    expect(card[2]).toContain("in_review")
    // A main session: the reverse.
    const main = withDispatcherProtocol(withStatusProtocol(["claude"], "claude", undefined, on), "claude", "m1", on)
    expect(main.filter((a) => a === "--append-system-prompt")).toHaveLength(1)
    expect(main[2]).toContain("DISPATCHER")
  })
})

describe("dispatcherProtocol", () => {
  it("bakes the task id and never instructs status writes", () => {
    const text = dispatcherProtocol("01HMAIN")
    expect(text).toContain("task 01HMAIN")
    expect(text).not.toContain("set-status")
  })

  it("pins the resolution rules: branch-direct, one yielder, never via main", () => {
    const text = dispatcherProtocol("01HMAIN")
    // Conflicts resolve between the two branches — waiting on a human main
    // merge would park the fleet on the one gate that's deliberately manual.
    expect(text).toContain("Never propose waiting for main")
    expect(text).toContain("ONE side to yield")
    // One direction only, and merge — no criss-cross, no rebase onto a
    // moving branch.
    expect(text).toContain("Never tell both sides to merge each other")
    expect(text).toContain("merge, don't rewrite")
  })
})
