/**
 * Why this matters: the registry is the seam that decouples pane lifecycle
 * (per-render) from shell lifecycle (per-task) — the terminal-in-the-middle
 * center column (issue #16) leans on acquire-reuse so switching tasks and
 * back does NOT restart the engine CLI. A regression here kills running
 * claude sessions on every sidebar keystroke.
 */

import { describe, expect, it } from "vitest"
import { MockTaskPty } from "../../src/tui/panes/terminal/pty-mock"
import type { TaskPtyOpts } from "../../src/tui/panes/terminal/pty-types"
import { PtyRegistry, _resetDefaultPtyRegistry, getDefaultPtyRegistry } from "../../src/tui/panes/terminal/registry"

const mockFactory = (opts: TaskPtyOpts) => new MockTaskPty(opts)

describe("PtyRegistry", () => {
  it("acquire reuses the live PTY for the same task (engine keeps running)", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/wt")
    const b = reg.acquire("t1", "/wt")
    expect(b).toBe(a)
    expect(reg.size).toBe(1)
  })

  it("acquire replaces an externally-killed PTY instead of returning a corpse", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/wt")
    a.kill()
    const b = reg.acquire("t1", "/wt")
    expect(b).not.toBe(a)
    expect(b.killed).toBe(false)
  })

  it("get/has hide dead PTYs and prune them", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/wt")
    expect(reg.has("t1")).toBe(true)
    a.kill()
    expect(reg.get("t1")).toBeNull()
    expect(reg.has("t1")).toBe(false)
    expect(reg.size).toBe(0)
  })

  it("release kills and forgets; releasing an absent id is a no-op", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/wt")
    reg.release("t1")
    expect(a.killed).toBe(true)
    expect(reg.size).toBe(0)
    reg.release("missing")
  })

  it("releaseAll leaves no live shells behind", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/a")
    const b = reg.acquire("t2", "/b")
    reg.releaseAll()
    expect(a.killed).toBe(true)
    expect(b.killed).toBe(true)
    expect(reg.size).toBe(0)
  })

  it("reset kills the old shell and hands back a fresh one", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("t1", "/wt")
    const fresh = reg.reset("t1", "/wt")
    expect(a.killed).toBe(true)
    expect(fresh).not.toBe(a)
    expect(reg.get("t1")).toBe(fresh)
  })
})

describe("default registry singleton", () => {
  it("is created lazily, shared, and reset drops every shell", () => {
    _resetDefaultPtyRegistry()
    const reg = getDefaultPtyRegistry()
    expect(getDefaultPtyRegistry()).toBe(reg)
    _resetDefaultPtyRegistry()
    expect(getDefaultPtyRegistry()).not.toBe(reg)
    _resetDefaultPtyRegistry()
  })
})

describe("TaskPty onExit contract (mock backend)", () => {
  it("notifies on kill and unsubscribes cleanly", () => {
    const pty = new MockTaskPty({ taskId: "t", cwd: "/" })
    let fired = 0
    const off = pty.onExit(() => {
      fired += 1
    })
    pty.onExit(() => {
      fired += 10
    })
    off()
    pty.kill()
    expect(fired).toBe(10)
  })

  it("fires immediately when subscribing to an already-dead PTY (fast-crash case)", () => {
    const pty = new MockTaskPty({ taskId: "t", cwd: "/" })
    pty.kill()
    let fired = false
    pty.onExit(() => {
      fired = true
    })
    expect(fired).toBe(true)
  })
})
