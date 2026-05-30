/**
 * Pure-helper tests for the tmux session layer (KOB-225).
 *
 * Only the name + argv builders are exercised here — the session ops
 * spawn `tmux` and are verified interactively, not in CI.
 */

import { describe, expect, test } from "vitest"
import {
  CHAT_TAB_CLOSE_BINDING,
  CHAT_TAB_RENAME_BINDING,
  CHAT_TAB_SWITCH_BINDINGS,
  attachArgv,
  parseWindowRoles,
  tmuxInitialSizeArgs,
  tmuxSessionName,
} from "../../src/tui/panes/terminal/tmux"

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

describe("CHAT_TAB_SWITCH_BINDINGS", () => {
  test("maps bracket chords to tmux window navigation", () => {
    expect(CHAT_TAB_SWITCH_BINDINGS).toEqual([
      ["bind-key", "-n", "C-[", "previous-window"],
      ["bind-key", "-n", "C-]", "next-window"],
    ])
  })
})

describe("CHAT_TAB_CLOSE_BINDING", () => {
  test("maps Ctrl+W to closing the current tmux window while protecting the last window", () => {
    expect(CHAT_TAB_CLOSE_BINDING).toEqual([
      "bind-key",
      "-n",
      "C-w",
      "if-shell",
      "-F",
      "#{>:#{session_windows},1}",
      "kill-window",
      "display-message 'Cannot close the only ChatTab'",
    ])
  })
})

describe("CHAT_TAB_RENAME_BINDING", () => {
  test("maps F2 to tmux window rename prompt", () => {
    expect(CHAT_TAB_RENAME_BINDING).toEqual([
      "bind-key",
      "-n",
      "F2",
      "command-prompt",
      "-I",
      "#{window_name}",
      "rename-window -- '%%'",
    ])
  })
})

describe("parseWindowRoles", () => {
  test("groups pane roles by tmux window id", () => {
    const roles = parseWindowRoles("@0\ttasks\n@0\tops\n@1\ttasks\n@1\tclaude\n@1\tops\n")
    expect([...(roles.get("@0") ?? [])]).toEqual(["tasks", "ops"])
    expect([...(roles.get("@1") ?? [])]).toEqual(["tasks", "claude", "ops"])
  })
})

describe("tmuxInitialSizeArgs", () => {
  test("uses tty dimensions for detached new-session sizing", () => {
    expect(tmuxInitialSizeArgs({ columns: 171, rows: 50 }, {})).toEqual(["-x", "171", "-y", "50"])
  })

  test("falls back to COLUMNS/LINES when stdout has no tty size", () => {
    expect(tmuxInitialSizeArgs({ columns: undefined, rows: undefined }, { COLUMNS: "120", LINES: "40" })).toEqual([
      "-x",
      "120",
      "-y",
      "40",
    ])
  })
})
