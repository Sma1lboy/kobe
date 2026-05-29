/**
 * Pure-builder tests for the tmux session layout (KOB-233).
 *
 * These are the regression net for the quoting / command-shape bugs
 * that previously only surfaced at runtime against a real tmux server.
 */

import { describe, expect, test } from "vitest"
import {
  fallbackOpsScript,
  keepAlive,
  opsPaneCommand,
  previewWindowCommand,
  shellQuote,
  shellQuoteArgv,
} from "../../src/tmux/session-layout.ts"

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
    expect(keepAlive("claude")).toBe('claude; exec "${SHELL:-/bin/sh}"')
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
    expect(cmd).toContain("'kobe' ops")
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
    expect(cmd.startsWith("'/bin/bun' '--preload' '/abs/preload.ts' '--conditions=browser' '/abs/cli.ts' ops")).toBe(
      true,
    )
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

describe("fallbackOpsScript", () => {
  test("cd's into the worktree and loops git status + a tree", () => {
    const s = fallbackOpsScript("/my wt")
    expect(s).toContain("cd '/my wt'")
    expect(s).toContain("git status --short --branch")
    expect(s).toContain("while :;")
    expect(s).toContain("sleep 2")
  })
})
