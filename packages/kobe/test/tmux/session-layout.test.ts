/**
 * Pure-builder tests for the tmux session layout (KOB-233).
 *
 * These are the regression net for the quoting / command-shape bugs
 * that previously only surfaced at runtime against a real tmux server.
 */

import { describe, expect, test } from "vitest"
import {
  PANE_PERCENT_MAX,
  PANE_PERCENT_MIN,
  TASKS_PANE_WIDTH,
  TASKS_PANE_WIDTH_MAX,
  TASKS_PANE_WIDTH_MIN,
  clampPanePercent,
  clampTasksPaneWidth,
  engineLaunchLine,
  fallbackOpsScript,
  keepAlive,
  openUrlCommand,
  opsPaneCommand,
  previewWindowCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
  updatePageCommand,
} from "../../src/tmux/session-layout.ts"

describe("layout constants", () => {
  test("keeps the direct-tmux Tasks pane wide enough for labels", () => {
    expect(TASKS_PANE_WIDTH).toBe(32)
  })
})

describe("clampTasksPaneWidth", () => {
  test("passes a sane in-range width through (rounded)", () => {
    expect(clampTasksPaneWidth(48)).toBe(48)
    expect(clampTasksPaneWidth(48.6)).toBe(49)
  })

  test("clamps below the minimum and above the maximum", () => {
    expect(clampTasksPaneWidth(TASKS_PANE_WIDTH_MIN - 5)).toBe(TASKS_PANE_WIDTH_MIN)
    expect(clampTasksPaneWidth(TASKS_PANE_WIDTH_MAX + 100)).toBe(TASKS_PANE_WIDTH_MAX)
  })

  test("falls back to the convention default on garbage", () => {
    expect(clampTasksPaneWidth(Number.NaN)).toBe(TASKS_PANE_WIDTH)
    expect(clampTasksPaneWidth(Number.POSITIVE_INFINITY)).toBe(TASKS_PANE_WIDTH)
  })
})

describe("clampPanePercent", () => {
  test("passes a sane in-range percentage through (rounded)", () => {
    expect(clampPanePercent(40)).toBe(40)
    expect(clampPanePercent(33.4)).toBe(33)
  })

  test("clamps below the minimum and above the maximum", () => {
    expect(clampPanePercent(PANE_PERCENT_MIN - 5)).toBe(PANE_PERCENT_MIN)
    expect(clampPanePercent(PANE_PERCENT_MAX + 20)).toBe(PANE_PERCENT_MAX)
  })

  test("returns null on garbage so callers skip the axis", () => {
    expect(clampPanePercent(Number.NaN)).toBeNull()
    expect(clampPanePercent(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("shellQuote", () => {
  test("wraps in single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'")
    expect(shellQuote("/has space/x")).toBe("'/has space/x'")
  })

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe("shellQuoteArgv", () => {
  test("quotes each element so multi-word elements survive a shell re-parse", () => {
    // The KOB-233 bug: `["sh","-c","echo a b"].join(" ")` lost the
    // quoting and the pane ran `sh -c echo` with `a`/`b` as $0/$1.
    expect(shellQuoteArgv(["sh", "-c", "echo a b"])).toBe("'sh' '-c' 'echo a b'")
  })
})

describe("keepAlive", () => {
  test("appends an exec-shell tail so the pane survives the command", () => {
    const out = keepAlive("claude")
    // command runs first, then the pane drops to an interactive shell
    expect(out.startsWith("claude; ")).toBe(true)
    expect(out).toContain('exec "${SHELL:-/bin/sh}"')
  })

  test("prints a banner before the shell when the command exits non-zero", () => {
    const out = keepAlive("claude")
    expect(out).toContain('__rc=$?; [ "$__rc" -ne 0 ]')
    expect(out).toContain("Engine exited (code %s)")
  })
})

describe("tasksPaneCommand", () => {
  test("runs the tasks pane with an optional initial task id", () => {
    expect(tasksPaneCommand(["kobe"])).toBe("'kobe' 'tasks'")
    expect(tasksPaneCommand(["kobe"], { initialTaskId: "task 1" })).toBe("'kobe' 'tasks' '--initial-task-id' 'task 1'")
  })
})

describe("opsPaneCommand", () => {
  test("runs `kobe ops` with task id, worktree, and target pane, then `|| fallback`", () => {
    const cmd = opsPaneCommand({
      cwd: "/wt",
      taskId: "t1",
      claudePaneId: "%3",
      cliInvocation: ["kobe"],
    })
    expect(cmd).toContain("KOBE_FILETREE_WATCH=1 'kobe' ops")
    expect(cmd).toContain("--task-id 't1'")
    expect(cmd).toContain("--worktree '/wt'")
    expect(cmd).toContain("--target-pane '%3'")
    expect(cmd).toContain("|| {")
    // fallback is embedded after the ||
    expect(cmd).toContain("git status --short --branch")
  })

  test("multi-token cli invocation (dev bun) is each-element quoted", () => {
    const cmd = opsPaneCommand({
      cwd: "/wt",
      taskId: "t1",
      claudePaneId: "%3",
      cliInvocation: ["/bin/bun", "--preload", "/abs/preload.ts", "--conditions=browser", "/abs/cli.ts"],
    })
    expect(
      cmd.startsWith(
        "KOBE_FILETREE_WATCH=1 '/bin/bun' '--preload' '/abs/preload.ts' '--conditions=browser' '/abs/cli.ts' ops",
      ),
    ).toBe(true)
  })

  test("threads the engine vendor through as --vendor when given", () => {
    const cmd = opsPaneCommand({
      cwd: "/wt",
      taskId: "t1",
      claudePaneId: "%3",
      cliInvocation: ["kobe"],
      vendor: "codex",
    })
    expect(cmd).toContain("--vendor 'codex'")
  })

  test("omits --vendor when no vendor is given", () => {
    const cmd = opsPaneCommand({ cwd: "/wt", taskId: "t1", claudePaneId: "%3", cliInvocation: ["kobe"] })
    expect(cmd).not.toContain("--vendor")
  })

  test("falls back to the inline watcher when there's no task id or pane", () => {
    const noTask = opsPaneCommand({ cwd: "/wt", taskId: undefined, claudePaneId: "%3", cliInvocation: ["kobe"] })
    const noPane = opsPaneCommand({ cwd: "/wt", taskId: "t1", claudePaneId: null, cliInvocation: ["kobe"] })
    expect(noTask).toBe(fallbackOpsScript("/wt"))
    expect(noPane).toBe(fallbackOpsScript("/wt"))
    expect(noTask).not.toContain("kobe ops")
  })
})

describe("previewWindowCommand", () => {
  test("runs `kobe ops --preview <file>` (opentui diff/code) with a pager fallback", () => {
    const cmd = previewWindowCommand({ worktree: "/my wt", relPath: "src/a b.ts", cliInvocation: ["kobe"] })
    // primary: the syntax-highlighted opentui preview
    expect(cmd).toContain("'kobe' ops --worktree '/my wt' --preview 'src/a b.ts'")
    // fallback after `||`: the user's own pager
    expect(cmd).toContain("|| {")
    expect(cmd).toContain("git diff HEAD -- 'src/a b.ts'")
    expect(cmd).toContain("delta --paging=always")
    expect(cmd).toContain("bat --style=plain --paging=always 'src/a b.ts'")
  })

  test("dev (multi-token) cli invocation is each-element quoted", () => {
    const cmd = previewWindowCommand({
      worktree: "/wt",
      relPath: "f.ts",
      cliInvocation: ["/bin/bun", "--preload", "/abs/p.ts", "--conditions=browser", "/abs/cli.ts"],
    })
    expect(
      cmd.startsWith("'/bin/bun' '--preload' '/abs/p.ts' '--conditions=browser' '/abs/cli.ts' ops --worktree"),
    ).toBe(true)
  })
})

describe("updatePageCommand", () => {
  test("runs the full-window update page through the kobe CLI invocation", () => {
    expect(updatePageCommand({ cliInvocation: ["kobe"] })).toBe("'kobe' 'update-page'")
  })

  test("quotes a multi-token dev invocation", () => {
    expect(updatePageCommand({ cliInvocation: ["/bin/bun", "--conditions=browser", "/abs/cli.ts"] })).toBe(
      "'/bin/bun' '--conditions=browser' '/abs/cli.ts' 'update-page'",
    )
  })
})

describe("openUrlCommand", () => {
  test("captures logical pane lines and opens a selected URL", () => {
    const cmd = openUrlCommand({ tmuxSocket: "kobe" })
    expect(cmd).toContain("tmux -L 'kobe' capture-pane -Jp -t '#{pane_id}' -S -500")
    expect(cmd).toContain("grep -oiE 'https?://")
    expect(cmd).toContain("awk '!seen[$0]++'")
    expect(cmd).toContain("command -v fzf >/dev/null && fzf --reverse || tail -1")
    expect(cmd).toContain("xargs -I{} open {}")
  })

  test("quotes the tmux socket name because it comes from the environment", () => {
    expect(openUrlCommand({ tmuxSocket: "kobe sandbox" })).toContain("tmux -L 'kobe sandbox'")
    expect(openUrlCommand({ tmuxSocket: "it's" })).toContain("tmux -L 'it'\\''s'")
  })
})

describe("fallbackOpsScript", () => {
  test("cd's into the worktree and loops git status + a tree", () => {
    const s = fallbackOpsScript("/my wt")
    expect(s).toContain("cd '/my wt'")
    expect(s).toContain("git status --short --branch")
    expect(s).toContain("while :;")
    expect(s).toContain("sleep 2")
  })
})

describe("engineLaunchLine", () => {
  const engine = shellQuoteArgv(["claude"])

  test("no init script → plain keepAlive", () => {
    expect(engineLaunchLine(engine)).toBe(keepAlive(engine))
    expect(engineLaunchLine(engine, { initScript: "   " })).toBe(keepAlive(engine))
  })

  test("init without a marker runs every launch, in a brace group (not a subshell)", () => {
    const line = engineLaunchLine(engine, { initScript: "export FOO=1" })
    // brace group so `export` reaches the engine — NOT a `( … )` subshell.
    expect(line).toContain("{\nexport FOO=1\n}")
    expect(line).not.toContain("(\nexport FOO=1\n)")
    // engine + keepAlive tail still present, and no marker guard.
    expect(line.endsWith(keepAlive(engine))).toBe(true)
    expect(line).not.toContain("[ ! -f")
  })

  test("init with a marker is once-per-worktree and touched only on success", () => {
    const line = engineLaunchLine(engine, {
      initScript: "sh .kobe/init.sh",
      markerPath: "/home/.kobe/worktree-init/ab",
    })
    // guard: run only when the marker is absent
    expect(line).toContain("if [ ! -f '/home/.kobe/worktree-init/ab' ]; then")
    // success-gate the touch ($? after the group), and mkdir the parent
    expect(line).toContain(
      "if [ $? -eq 0 ]; then mkdir -p '/home/.kobe/worktree-init' && : > '/home/.kobe/worktree-init/ab'; fi",
    )
    expect(line.endsWith(keepAlive(engine))).toBe(true)
  })

  test("single-quotes in the marker path are escaped", () => {
    const line = engineLaunchLine(engine, { initScript: "x", markerPath: "/a'b/m" })
    expect(line).toContain("'/a'\\''b/m'")
  })
})
