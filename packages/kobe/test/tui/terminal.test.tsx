/**
 * Stream J — Terminal pane unit tests.
 *
 * Same architectural constraint as Stream F's sidebar tests: vitest
 * runs under Node and can't load `@opentui/core`'s Bun-FFI structs,
 * so we don't render the JSX component. Instead we exercise the pure
 * pieces:
 *
 *   - `MockTaskPty` round-trip: write → onData receives the synthetic
 *     output, capture returns the buffer, kill cleans up.
 *   - `PtyRegistry` invariants: one PTY per task id, reuse on repeated
 *     `acquire`, kill on `release`, `releaseAll` empties the map.
 *   - `keyEventToShellBytes`: every named key → expected byte sequence.
 *
 * The Solid component itself is exercised end-to-end in
 * `test/behavior/terminal.test.ts`, which spawns the real binary
 * under tmux and asserts on visible behavior.
 */

import type { KeyEvent } from "@opentui/core"
import { afterEach, describe, expect, test } from "vitest"
import { keyEventToShellBytes } from "../../src/tui/panes/terminal/keys-pure"
import { MockTaskPty, type TaskPty } from "../../src/tui/panes/terminal/pty"
import { PtyRegistry } from "../../src/tui/panes/terminal/registry"

/* --------------------------------------------------------------------- */
/*  Helpers                                                               */
/* --------------------------------------------------------------------- */

function key(name: string, opts: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: undefined as unknown as string,
    ...opts,
  } as KeyEvent
}

/* --------------------------------------------------------------------- */
/*  MockTaskPty — write/onData round-trip                                 */
/* --------------------------------------------------------------------- */

describe("MockTaskPty", () => {
  test("write() records the bytes for tests to inspect", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    pty.write("hello")
    pty.write(" world\r\n")
    expect(pty.writeLog).toEqual(["hello", " world\r\n"])
  })

  test("feed() pushes synthetic output to onData listeners", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    const got: string[] = []
    pty.onData((s) => got.push(s))
    pty.feed("first\n")
    pty.feed("second\n")
    // Listeners receive the full buffer each tick (matches tmux backend).
    expect(got).toEqual(["first\n", "first\nsecond\n"])
  })

  test("onData receives current buffer on subscribe if non-empty", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    pty.feed("preexisting\n")
    const got: string[] = []
    pty.onData((s) => got.push(s))
    expect(got).toEqual(["preexisting\n"])
  })

  test("onData unsubscribe stops further notifications", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    const got: string[] = []
    const unsub = pty.onData((s) => got.push(s))
    pty.feed("a")
    unsub()
    pty.feed("b")
    expect(got).toEqual(["a"])
  })

  test("capture() returns the current buffer", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    pty.feed("line one\n")
    pty.feed("line two\n")
    expect(pty.capture()).toBe("line one\nline two\n")
  })

  test("resize() updates geometry", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp", cols: 80, rows: 24 })
    expect(pty.geometry).toEqual({ cols: 80, rows: 24 })
    pty.resize(120, 40)
    expect(pty.geometry).toEqual({ cols: 120, rows: 40 })
  })

  test("kill() is idempotent and clears listeners", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    let calls = 0
    pty.onData(() => calls++)
    pty.feed("x")
    expect(calls).toBe(1)
    expect(pty.killed).toBe(false)

    pty.kill()
    expect(pty.killed).toBe(true)
    // Further feeds do nothing
    pty.feed("y")
    expect(calls).toBe(1)
    // Second kill doesn't throw
    pty.kill()
    expect(pty.killed).toBe(true)
  })

  test("write() after kill is a no-op", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
    pty.kill()
    pty.write("ignored")
    expect(pty.writeLog).toEqual([])
  })
})

/* --------------------------------------------------------------------- */
/*  PtyRegistry — one-per-task invariant                                  */
/* --------------------------------------------------------------------- */

describe("PtyRegistry", () => {
  let mocks: MockTaskPty[] = []

  function mockFactory(opts: { taskId: string; cwd: string }): TaskPty {
    const m = new MockTaskPty(opts)
    mocks.push(m)
    return m
  }

  afterEach(() => {
    for (const m of mocks) m.kill()
    mocks = []
  })

  test("acquire() creates a new PTY on first call", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    expect(a).toBeDefined()
    expect(a.taskId).toBe("task-1")
    expect(reg.size).toBe(1)
  })

  test("acquire() reuses the same PTY for the same task id", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    const b = reg.acquire("task-1", "/tmp/work")
    expect(a).toBe(b) // same instance
    expect(reg.size).toBe(1)
    expect(mocks).toHaveLength(1)
  })

  test("acquire() creates separate PTYs for different task ids", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/a")
    const b = reg.acquire("task-2", "/tmp/b")
    expect(a).not.toBe(b)
    expect(reg.size).toBe(2)
  })

  test("get() returns null for unknown task id", () => {
    const reg = new PtyRegistry(mockFactory)
    expect(reg.get("nope")).toBeNull()
  })

  test("get() returns the live PTY for an acquired task", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    expect(reg.get("task-1")).toBe(a)
    expect(reg.has("task-1")).toBe(true)
  })

  test("get() returns null for an externally-killed PTY and clears the slot", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    a.kill()
    expect(reg.get("task-1")).toBeNull()
    expect(reg.size).toBe(0)
  })

  test("acquire() after external kill spawns a fresh PTY", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    a.kill()
    const b = reg.acquire("task-1", "/tmp/work")
    expect(b).not.toBe(a)
    expect(b.killed).toBe(false)
  })

  test("release() kills and forgets the PTY", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/work")
    expect(a.killed).toBe(false)
    reg.release("task-1")
    expect(a.killed).toBe(true)
    expect(reg.size).toBe(0)
    expect(reg.has("task-1")).toBe(false)
  })

  test("release() on unknown id is a no-op", () => {
    const reg = new PtyRegistry(mockFactory)
    expect(() => reg.release("nope")).not.toThrow()
  })

  test("releaseAll() kills every tracked PTY", () => {
    const reg = new PtyRegistry(mockFactory)
    const a = reg.acquire("task-1", "/tmp/a")
    const b = reg.acquire("task-2", "/tmp/b")
    const c = reg.acquire("task-3", "/tmp/c")
    expect(reg.size).toBe(3)
    reg.releaseAll()
    expect(reg.size).toBe(0)
    expect(a.killed).toBe(true)
    expect(b.killed).toBe(true)
    expect(c.killed).toBe(true)
  })
})

/* --------------------------------------------------------------------- */
/*  keyEventToShellBytes — encoding                                       */
/* --------------------------------------------------------------------- */

describe("keyEventToShellBytes", () => {
  test("forwards evt.sequence verbatim when present", () => {
    const evt = key("a", { sequence: "\x1bOA" }) // weird made-up sequence
    expect(keyEventToShellBytes(evt)).toBe("\x1bOA")
  })

  test("returns null for unknown named keys without sequence", () => {
    const evt = key("synthetic-unknown")
    expect(keyEventToShellBytes(evt)).toBeNull()
  })

  test("synthesizes return as \\r", () => {
    expect(keyEventToShellBytes(key("return"))).toBe("\r")
    expect(keyEventToShellBytes(key("enter"))).toBe("\r")
  })

  test("synthesizes navigation keys to ANSI sequences", () => {
    expect(keyEventToShellBytes(key("up"))).toBe("\x1b[A")
    expect(keyEventToShellBytes(key("down"))).toBe("\x1b[B")
    expect(keyEventToShellBytes(key("right"))).toBe("\x1b[C")
    expect(keyEventToShellBytes(key("left"))).toBe("\x1b[D")
    expect(keyEventToShellBytes(key("home"))).toBe("\x1b[H")
    expect(keyEventToShellBytes(key("end"))).toBe("\x1b[F")
  })

  test("synthesizes backspace and delete", () => {
    expect(keyEventToShellBytes(key("backspace"))).toBe("\x7f")
    expect(keyEventToShellBytes(key("delete"))).toBe("\x1b[3~")
  })

  test("synthesizes escape", () => {
    expect(keyEventToShellBytes(key("escape"))).toBe("\x1b")
  })

  test("synthesizes ctrl+c as 0x03", () => {
    expect(keyEventToShellBytes(key("c", { ctrl: true }))).toBe("\x03")
  })

  test("synthesizes ctrl+d as 0x04", () => {
    expect(keyEventToShellBytes(key("d", { ctrl: true }))).toBe("\x04")
  })

  test("synthesizes ctrl+a as 0x01 (line start)", () => {
    expect(keyEventToShellBytes(key("a", { ctrl: true }))).toBe("\x01")
  })

  test("plain letter without ctrl is forwarded as-is", () => {
    expect(keyEventToShellBytes(key("x"))).toBe("x")
  })
})
