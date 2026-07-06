/**
 * Pure-helper tests for the tmux session layer (KOB-225).
 *
 * Only the name + argv builders are exercised here — the session ops
 * spawn `tmux` and are verified interactively, not in CI.
 */

import { describe, expect, test } from "vitest"
import {
  CHAT_TAB_ENGINE_PROMPT,
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  attachArgv,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  clientsWithConflictingSize,
  focusBindCommand,
  kobeStatusRight,
  parseObservedSession,
  parseTmuxClientRows,
  tasksRestoreEdgeCommand,
  tmuxInitialSizeArgs,
  tmuxSessionName,
  tmuxWindowSizeArgsForClient,
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

describe("chatTabSwitchBindings", () => {
  test("maps the resolved prev/next keys to tmux window navigation, guarded off on surface pages", () => {
    const guard = "#{?#{@kobe_surface},0,1}"
    expect(chatTabSwitchBindings("C-[", "C-]")).toEqual([
      ["bind-key", "-n", "C-[", "if-shell", "-F", guard, "previous-window"],
      ["bind-key", "-n", "C-]", "if-shell", "-F", guard, "next-window"],
    ])
  })
})

describe("focusBindCommand", () => {
  // Directional focus must NOT wrap: bare `select-pane -L` jumps from the
  // leftmost Tasks pane to the RIGHTMOST pane. Each bind is gated on the
  // matching `pane_at_*` edge format var — "" at the edge (falsy →
  // if-shell runs nothing; the else command is omitted, which parses)
  // and "1" elsewhere (→ the move runs). The OUTER window_zoomed_flag
  // conditional exempts zoomed panes: zoom sets ALL FOUR pane_at_* flags
  // to 1, which would otherwise make every focus chord a dead key while
  // zoomed — zoomed presses fall through to plain select-pane (unzoom +
  // move, the pre-guard behavior). Both halves verified live on tmux
  // 3.5a with an attached client.
  test("guards each direction with its pane_at_* edge variable", () => {
    expect(focusBindCommand("C-h", "-L")).toEqual([
      "bind-key",
      "-n",
      "C-h",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_left,,1}}",
      "select-pane -L",
    ])
    expect(focusBindCommand("C-j", "-D")).toEqual([
      "bind-key",
      "-n",
      "C-j",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_bottom,,1}}",
      "select-pane -D",
    ])
    expect(focusBindCommand("C-k", "-U")).toEqual([
      "bind-key",
      "-n",
      "C-k",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_top,,1}}",
      "select-pane -U",
    ])
    expect(focusBindCommand("C-l", "-R")).toEqual([
      "bind-key",
      "-n",
      "C-l",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_right,,1}}",
      "select-pane -R",
    ])
  })

  // The guard lives on the COMMAND side, so a user-overridden tmux.focus
  // key set (resolveUserTmuxKeys) gets the same no-wrap behavior.
  test("wraps whatever resolved key the user chose for the direction", () => {
    expect(focusBindCommand("C-Left", "-L")).toEqual([
      "bind-key",
      "-n",
      "C-Left",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_left,,1}}",
      "select-pane -L",
    ])
  })

  test("can run a no-wrap edge command for hidden Tasks restore", () => {
    expect(focusBindCommand("C-h", "-L", "run-shell restore")).toEqual([
      "bind-key",
      "-n",
      "C-h",
      "if-shell",
      "-F",
      "#{?window_zoomed_flag,1,#{?pane_at_left,,1}}",
      "select-pane -L",
      "run-shell restore",
    ])
  })
})

describe("tasksRestoreEdgeCommand", () => {
  // Regression: the ctrl+h left-edge restore used to be a FOREGROUND
  // run-shell, which stalls tmux's whole command queue until the kobe CLI
  // exits — every press inside the leftmost Tasks pane froze the client
  // for a full CLI startup, and rapid presses compounded into multi-second
  // freezes ("shortcut keys are very random / kobe gets stuck"). The fix
  // is twofold and both halves must survive: the spawn is backgrounded
  // (`run-shell -b`) and skipped entirely when the active pane already IS
  // the Tasks rail (`@kobe_role=tasks`). The run-shell is nested in tmux
  // BRACES, never double quotes: the shell-quoted command carries `'\''`
  // sequences that double-quote re-parsing corrupts ("too many
  // arguments"). Gate + brace re-parsing verified live on tmux 3.6 via
  // `run-shell -C` with a production-shaped command.
  test("backgrounds the CLI spawn and skips it when the Tasks rail is the active pane", () => {
    expect(tasksRestoreEdgeCommand("kobe layout --session '#{session_name}' --action tasks-restore")).toBe(
      `if-shell -F '#{?#{==:#{@kobe_role},tasks},,1}' { run-shell -b 'kobe layout --session '\\''#{session_name}'\\'' --action tasks-restore' }`,
    )
  })
})

describe("chatTabCloseBinding", () => {
  test("maps the resolved key to closing the current tmux window while protecting the last window", () => {
    expect(chatTabCloseBinding("C-w")).toEqual([
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

  test("can route close through the kobe cleanup command before killing the window", () => {
    expect(chatTabCloseBinding("C-w", "run-shell 'kobe layout --action chat-tab-close'")).toEqual([
      "bind-key",
      "-n",
      "C-w",
      "if-shell",
      "-F",
      "#{>:#{session_windows},1}",
      "run-shell 'kobe layout --action chat-tab-close'",
      "display-message 'Cannot close the only ChatTab'",
    ])
  })
})

describe("chatTabRenameBinding", () => {
  test("maps the resolved key to the tmux window rename prompt", () => {
    expect(chatTabRenameBinding("F2")).toEqual([
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

describe("chatTabChooseEngineBindings", () => {
  test("maps the resolved no-prefix key and the fixed prefix T to the engine-choice prompt", () => {
    expect(CHAT_TAB_ENGINE_PROMPT).toBe("engine (claude/codex/copilot/…)")
    expect(chatTabChooseEngineBindings("C-S-T")).toEqual([
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

describe("tmux client size conflict helpers", () => {
  test("derives target window size from the current client size", () => {
    expect(tmuxWindowSizeArgsForClient({ columns: 171, rows: 52 }, { status: "on" })).toEqual(["-x", "171", "-y", "51"])
    expect(tmuxWindowSizeArgsForClient({ columns: 171, rows: 52 }, { status: "off" })).toEqual([
      "-x",
      "171",
      "-y",
      "52",
    ])
  })

  test("parses client rows from list-clients", () => {
    expect(
      parseTmuxClientRows(
        [
          "/dev/ttys000\tkobe-a\t171\t52\tattached,focused,UTF-8",
          "/dev/ttys001\tkobe-a\t120\t31\tattached,UTF-8",
          "/dev/ttys002\tkobe-b\t90\t25\tattached,UTF-8",
          "broken\trow",
        ].join("\n"),
      ),
    ).toEqual([
      { name: "/dev/ttys000", session: "kobe-a", width: 171, height: 52, flags: "attached,focused,UTF-8" },
      { name: "/dev/ttys001", session: "kobe-a", width: 120, height: 31, flags: "attached,UTF-8" },
      { name: "/dev/ttys002", session: "kobe-b", width: 90, height: 25, flags: "attached,UTF-8" },
    ])
  })

  test("selects only other clients on the target session whose terminal size differs", () => {
    const rows = parseTmuxClientRows(
      [
        "/dev/current\tkobe-a\t171\t52\tattached,focused,UTF-8",
        "/dev/same-size\tkobe-a\t171\t52\tattached,UTF-8",
        "/dev/small\tkobe-a\t120\t31\tattached,UTF-8",
        "/dev/other-session\tkobe-b\t120\t31\tattached,UTF-8",
      ].join("\n"),
    )

    expect(
      clientsWithConflictingSize(rows, "kobe-a", { columns: 171, rows: 52 }, { currentClientName: "/dev/current" }),
    ).toEqual(["/dev/small"])
  })
})

describe("parseObservedSession", () => {
  // One `list-panes -s` answers all four observe questions (the reuse path
  // runs on EVERY task switch, so its spawn count matters): session options
  // ride the format on every row, `window_active` scopes the claude-pane
  // check to the current window, distinct window ids are the tab count.
  test("derives options, active-window claude pane and window count from one listing", () => {
    const stdout = [
      "@1\t0\tclaude\t/wt/a\tclaude", // claude pane in an INACTIVE window
      "@1\t0\ttasks\t/wt/a\tclaude",
      "@2\t1\tclaude\t/wt/a\tclaude", // the active window's claude pane
      "@2\t1\t\t/wt/a\tclaude", // untagged shell pane
    ].join("\n")
    expect(parseObservedSession(stdout)).toEqual({
      worktree: "/wt/a",
      vendor: "claude",
      claudePaneAlive: true,
      windowCount: 2,
    })
  })

  test("a claude pane only in an inactive window does NOT count as alive", () => {
    const stdout = ["@1\t0\tclaude\t/wt/a\tcodex", "@2\t1\ttasks\t/wt/a\tcodex"].join("\n")
    expect(parseObservedSession(stdout)).toEqual({
      worktree: "/wt/a",
      vendor: "codex",
      claudePaneAlive: false,
      windowCount: 2,
    })
  })

  test("unset session options degrade to empty strings (legacy/pre-tag session)", () => {
    expect(parseObservedSession("@1\t1\t\t\t\n")).toEqual({
      worktree: "",
      vendor: "",
      claudePaneAlive: false,
      windowCount: 1,
    })
  })
})

describe("kobeStatusRight", () => {
  test("renders the three escape-hatch hints from the resolved keys", () => {
    expect(
      kobeStatusRight({
        focusLeft: "C-h",
        detach: "C-q",
        newTab: "C-t",
        layoutSplits: "s/x/r",
        layoutPanes: "a/o/z",
      }),
    ).toBe("^h tasks  ^q detach  ^t tab  prefix s/x/r splits  prefix a/o/z panes ")
  })

  test("shows overridden chords and drops unbound segments", () => {
    expect(kobeStatusRight({ focusLeft: null, detach: "M-d", newTab: "C-y", layoutSplits: null })).toBe(
      "M-d detach  ^y tab ",
    )
  })
})
