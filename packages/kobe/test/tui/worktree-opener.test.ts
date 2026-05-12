import { describe, expect, it, vi } from "vitest"
import { buildOpenWorktreeCommand, detectWorktreeOpener, openWorktree } from "../../src/tui/lib/worktree-opener.ts"

describe("detectWorktreeOpener", () => {
  it("honors KOBE_OPEN_EDITOR", () => {
    expect(
      detectWorktreeOpener({
        env: { KOBE_OPEN_EDITOR: "cursor", PATH: "" },
        exists: () => false,
      }),
    ).toEqual({ id: "env", label: "Cursor", command: "cursor", args: [] })
  })

  it("prefers Cursor on PATH before VS Code", () => {
    const opener = detectWorktreeOpener({
      env: { PATH: "/bin:/apps" },
      exists: (path) => path === "/apps/cursor" || path === "/apps/code",
    })

    expect(opener).toEqual({ id: "cursor", label: "Cursor", command: "cursor", args: [] })
  })

  it("falls back to macOS app opening when editor CLIs are absent", () => {
    const opener = detectWorktreeOpener({
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      exists: (path) => path === "/usr/bin/open" || path === "/Applications/Visual Studio Code.app",
    })

    expect(opener).toEqual({
      id: "vscode.app",
      label: "VS Code",
      command: "open",
      args: ["-a", "Visual Studio Code"],
    })
  })
})

describe("openWorktree", () => {
  it("appends the worktree path to the opener command", () => {
    expect(
      buildOpenWorktreeCommand("/repo/.claude/worktrees/task-1", {
        id: "cursor",
        label: "Cursor",
        command: "cursor",
        args: [],
      }),
    ).toEqual(["cursor", ["/repo/.claude/worktrees/task-1"]])
  })

  it("spawns detached and unrefs the child", () => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ pid: 123, unref }))

    const ok = openWorktree(
      "/repo/task",
      { id: "code", label: "VS Code", command: "code", args: [] },
      { spawn: spawn as never },
    )

    expect(ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith("code", ["/repo/task"], { detached: true, stdio: "ignore" })
    expect(unref).toHaveBeenCalled()
  })
})
