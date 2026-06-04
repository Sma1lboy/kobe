import { describe, expect, it } from "vitest"
import { parseWorktreeAddPath } from "../../src/cli/hook-cmd.ts"

/**
 * `parseWorktreeAddPath` extracts the worktree path from a Bash command so the
 * global `PostToolUse` (Bash) hook can adopt a freshly-created worktree. It must
 * find the path past `git worktree add`'s flags, ignore non-worktree commands,
 * and never be fooled by a chained command into adopting the wrong token.
 */
describe("parseWorktreeAddPath", () => {
  it("returns undefined for commands that aren't a worktree-add", () => {
    expect(parseWorktreeAddPath("git status")).toBeUndefined()
    expect(parseWorktreeAddPath("ls -la")).toBeUndefined()
    expect(parseWorktreeAddPath("git worktree list")).toBeUndefined()
    expect(parseWorktreeAddPath("git worktree remove foo")).toBeUndefined()
  })

  it("extracts a bare path", () => {
    expect(parseWorktreeAddPath("git worktree add .claude/worktrees/lynx")).toBe(".claude/worktrees/lynx")
  })

  it("skips the value of `-b` / `-B` and returns the path", () => {
    expect(parseWorktreeAddPath("git worktree add -b kobe/feat .claude/worktrees/lynx main")).toBe(
      ".claude/worktrees/lynx",
    )
    expect(parseWorktreeAddPath("git worktree add -B kobe/feat /tmp/wt")).toBe("/tmp/wt")
  })

  it("skips boolean flags like --force / --detach / -q", () => {
    expect(parseWorktreeAddPath("git worktree add --force --detach -q ../wt")).toBe("../wt")
  })

  it("skips the value of `--reason`, and `--reason=...` self-contained form", () => {
    expect(parseWorktreeAddPath('git worktree add --reason "busy" wt')).toBe("wt")
    expect(parseWorktreeAddPath("git worktree add --reason=busy wt")).toBe("wt")
  })

  it("strips quotes around the path", () => {
    expect(parseWorktreeAddPath('git worktree add "my worktrees/lynx"')).toBe("my worktrees/lynx")
  })

  it("finds the worktree add inside a compound command", () => {
    expect(parseWorktreeAddPath("cd /repo && git worktree add -b x wt main")).toBe("wt")
  })

  it("stops at a shell operator so a chained command can't masquerade as the path", () => {
    // No positional path before `&&` → not a usable worktree-add target.
    expect(parseWorktreeAddPath("git worktree add -b x && echo done")).toBeUndefined()
  })
})
