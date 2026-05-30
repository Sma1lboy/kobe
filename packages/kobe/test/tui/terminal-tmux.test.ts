/**
 * Pure-helper tests for the tmux session layer (KOB-225).
 *
 * Only the name + argv builders are exercised here — the session ops
 * spawn `tmux` and are verified interactively, not in CI.
 */

import { describe, expect, test } from "vitest"
import {
  CHAT_TAB_CHOOSE_ENGINE_BINDINGS,
  CHAT_TAB_CLOSE_BINDING,
  CHAT_TAB_ENGINE_PROMPT,
  CHAT_TAB_RENAME_BINDING,
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  CHAT_TAB_SWITCH_BINDINGS,
  attachArgv,
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

describe("CHAT_TAB_CHOOSE_ENGINE_BINDINGS", () => {
  test("maps Ctrl+Shift+T and prefix T to the engine-choice prompt", () => {
    expect(CHAT_TAB_ENGINE_PROMPT).toBe("engine (claude/codex/copilot)")
    expect(CHAT_TAB_CHOOSE_ENGINE_BINDINGS).toEqual([
      ["bind-key", "-n", "C-S-T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
      ["bind-key", "T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
    ])
  })
})

describe("CHAT_TAB_STATUS_FORMAT", () => {
  test("prefixes tmux window labels with a detector-owned state icon", () => {
    expect(CHAT_TAB_STATUS_FORMAT).toContain("@kobe_tab_state")
    expect(CHAT_TAB_STATUS_FORMAT).toContain("running")
    expect(CHAT_TAB_STATUS_FORMAT).toContain("done")
    expect(CHAT_TAB_STATUS_CURRENT_FORMAT).toBe(CHAT_TAB_STATUS_FORMAT)
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
