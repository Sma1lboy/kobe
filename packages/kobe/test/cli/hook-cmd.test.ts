import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseWorktreeAddPath, parseWorktreeRemovePath, readTextWithTimeout } from "../../src/cli/hook-cmd.ts"

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
    expect(parseWorktreeAddPath("git worktree add -b x && echo done")).toBeUndefined()
  })
})

describe("parseWorktreeRemovePath", () => {
  it("returns undefined for commands that aren't a worktree-remove", () => {
    expect(parseWorktreeRemovePath("git status")).toBeUndefined()
    expect(parseWorktreeRemovePath("git worktree list")).toBeUndefined()
    expect(parseWorktreeRemovePath("git worktree add foo")).toBeUndefined()
  })

  it("extracts a bare path", () => {
    expect(parseWorktreeRemovePath("git worktree remove .claude/worktrees/lynx")).toBe(".claude/worktrees/lynx")
  })

  it("skips boolean flags like -f / --force", () => {
    expect(parseWorktreeRemovePath("git worktree remove -f ../wt")).toBe("../wt")
    expect(parseWorktreeRemovePath("git worktree remove --force /tmp/wt")).toBe("/tmp/wt")
  })

  it("strips quotes around the path", () => {
    expect(parseWorktreeRemovePath('git worktree remove "my worktrees/lynx"')).toBe("my worktrees/lynx")
  })

  it("finds the worktree remove inside a compound command", () => {
    expect(parseWorktreeRemovePath("cd /repo && git worktree remove -f wt")).toBe("wt")
  })

  it("stops at a shell operator so a chained command can't masquerade as the path", () => {
    expect(parseWorktreeRemovePath("git worktree remove -f && echo done")).toBeUndefined()
  })
})

describe("readTextWithTimeout timer hygiene", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("clears the fallback timer once the reader wins, leaving no pending timers", async () => {
    const result = await readTextWithTimeout(async () => "payload", 500)
    expect(result).toBe("payload")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the timer even when the reader rejects (finally, not catch)", async () => {
    await expect(readTextWithTimeout(async () => Promise.reject(new Error("boom")), 500)).rejects.toThrow("boom")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("falls back to '' when the reader never settles before the timeout", async () => {
    const promise = readTextWithTimeout(() => new Promise<string>(() => {}), 500)
    await vi.advanceTimersByTimeAsync(500)
    expect(await promise).toBe("")
    expect(vi.getTimerCount()).toBe(0)
  })
})
