/**
 * Pure-helper tests for the tmux session layer (KOB-225).
 *
 * Only the name + argv builders are exercised here — the session ops
 * spawn `tmux` and are verified interactively, not in CI.
 */

import { describe, expect, test } from "vitest"
import { attachArgv, tmuxSessionName } from "../../src/tui/panes/terminal/tmux"

describe("tmuxSessionName", () => {
  test("prefixes with kobe- and keeps safe id chars", () => {
    expect(tmuxSessionName("01HXYZ_abc-123")).toBe("kobe-01HXYZ_abc-123")
  })

  test("strips characters tmux disallows in names (. and :)", () => {
    expect(tmuxSessionName("a.b:c/d e")).toBe("kobe-abcde")
  })
})

describe("attachArgv", () => {
  test("targets the dedicated socket and an exact session name", () => {
    expect(attachArgv("kobe-t1")).toEqual(["tmux", "-L", "kobe", "attach-session", "-t", "=kobe-t1"])
  })
})
