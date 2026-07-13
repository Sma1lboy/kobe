/** @jsxImportSource @opentui/react */
/**
 * Terminal pane error/exit paths, driven end-to-end through a scripted
 * fake PTY (`createScriptedPtyRegistry` — zero subprocesses). These are
 * the paths the slow behavior track never reaches cheaply:
 *
 *   - `registry.acquire()` throwing → the pane surfaces the spawn error
 *     (generic + shell-missing variants) instead of rendering blank;
 *   - engine exit → dead-shell banner + `onExit` fires, with the scripted
 *     `deadOnAttach` flag passed through for the resume-vs-degrade split;
 *   - `resetToken` → forceReacquire lands a FRESH pty (old one killed),
 *     and a reset whose acquire half throws surfaces the error rather
 *     than leaving a dead snapshot up with the message swallowed.
 *
 * Registry/factory semantics themselves (reuse, release, reset-kills-old)
 * stay on the cheap vitest track — `test/tui/terminal-registry.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { useState } from "react"
import { modalActive } from "../../src/tui-react/lib/keymap"
import { Terminal } from "../../src/tui-react/panes/terminal/Terminal"
import { type ScriptedPtyRegistry, createScriptedPtyRegistry } from "../../src/tui/panes/terminal/pty-scripted"
import { type RenderHandle, act, renderComponent } from "./harness"

type ExitInfo = { deadOnAttach?: boolean } | undefined

/**
 * act()-wrapped mount + frame. The Terminal pane's geometry hooks setState
 * from layout callbacks (`onSizeChange` → geomTick, body measurement) during
 * the harness's plain `flush()`, so the un-wrapped helpers drown the output
 * in "not wrapped in act" warnings for every render pass.
 */
async function mountTerminal(
  ui: Parameters<typeof renderComponent>[0],
): Promise<RenderHandle & { aframe: () => Promise<string> }> {
  let handle: RenderHandle | undefined
  await act(async () => {
    handle = await renderComponent(ui, { providers: { dialog: true } })
  })
  if (!handle) throw new Error("mount failed")
  const h = handle
  return {
    ...h,
    aframe: async () => {
      let s = ""
      await act(async () => {
        s = await h.frame()
      })
      return s
    },
  }
}

/** Mount host that lets a test bump `resetToken` after the fact. */
function ResetHost(props: {
  harness: ScriptedPtyRegistry
  api: { bumpReset?: () => void }
  onExit?: (info?: ExitInfo) => void
}) {
  const [token, setToken] = useState(0)
  props.api.bumpReset = () => setToken((n) => n + 1)
  return (
    <Terminal
      cwd="/wt"
      taskId="t1"
      focused
      registry={props.harness.registry}
      resetToken={token}
      onExit={props.onExit}
    />
  )
}

function SwitchHost(props: {
  harness: ScriptedPtyRegistry
  api: { switchTo?: (taskId: string, cwd: string) => void }
}) {
  const [target, setTarget] = useState({ taskId: "t1", cwd: "/wt-1" })
  props.api.switchTo = (taskId, cwd) => setTarget({ taskId, cwd })
  return <Terminal cwd={target.cwd} taskId={target.taskId} focused registry={props.harness.registry} />
}

function UnmountHost(props: { harness: ScriptedPtyRegistry; api: { hide?: () => void } }) {
  const [shown, setShown] = useState(true)
  props.api.hide = () => setShown(false)
  return shown ? <Terminal cwd="/wt" taskId="t1" focused registry={props.harness.registry} /> : <box />
}

describe("Terminal pane on a scripted fake PTY", () => {
  test("renders scripted output, then shows the exit banner and fires onExit on engine exit", async () => {
    const harness = createScriptedPtyRegistry()
    const exits: ExitInfo[] = []
    const { aframe: frame } = await mountTerminal(
      <Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} onExit={(info) => exits.push(info)} />,
    )

    await frame() // geometry effect → acquire
    expect(harness.ptys.length).toBe(1)

    await act(async () => harness.last().feed("hello from fake shell\r\n$ "))
    expect(await frame()).toContain("hello from fake shell")
    expect(exits).toEqual([])

    await act(async () => harness.last().kill())
    const dead = await frame()
    expect(dead).toContain("process exited — F5 restarts it")
    // The last snapshot stays visible under the banner (no blank pane).
    expect(dead).toContain("hello from fake shell")
    expect(exits).toEqual([{ deadOnAttach: false }])
  })

  test("scripted deadOnAttach reaches the onExit consumer (resume-vs-degrade discriminator)", async () => {
    const harness = createScriptedPtyRegistry()
    const exits: ExitInfo[] = []
    const { aframe: frame } = await mountTerminal(
      <Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} onExit={(info) => exits.push(info)} />,
    )
    await frame()
    await act(async () => {
      harness.last().deadOnAttach = true
      harness.last().kill()
    })
    await frame()
    expect(exits).toEqual([{ deadOnAttach: true }])
  })

  test("acquire failure surfaces the spawn error instead of a blank pane", async () => {
    const harness = createScriptedPtyRegistry()
    harness.failNextAcquire("spawn kobe-shell EACCES")
    const { aframe: frame } = await mountTerminal(
      <Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} />,
    )
    const f = await frame()
    expect(f).toContain("terminal unavailable — shell could not start")
    expect(f).toContain("spawn kobe-shell EACCES")
    expect(harness.ptys.length).toBe(0)
  })

  test("acquire failure mentioning ENOENT swaps in the shell-missing hint", async () => {
    const harness = createScriptedPtyRegistry()
    harness.failNextAcquire("spawn /bin/zshh ENOENT")
    const { aframe: frame } = await mountTerminal(
      <Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} />,
    )
    const f = await frame()
    expect(f).toContain("terminal unavailable — configured shell is not available")
    expect(f).toContain("ENOENT")
  })

  test("resetToken bump force-reacquires: old pty killed, fresh pty rendered, banner cleared", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { bumpReset?: () => void } = {}
    const { aframe: frame } = await mountTerminal(<ResetHost harness={harness} api={api} />)
    await frame()
    expect(harness.ptys.length).toBe(1)
    const first = harness.last()
    await act(async () => first.feed("old shell output\r\n"))
    await act(async () => first.kill())
    expect(await frame()).toContain("process exited — F5 restarts it")

    await act(async () => api.bumpReset?.())
    expect(harness.ptys.length).toBe(2)
    expect(harness.ptys[0]?.killed).toBe(true)

    await act(async () => harness.last().feed("fresh shell\r\n$ "))
    const f = await frame()
    expect(f).toContain("fresh shell")
    expect(f).not.toContain("process exited")
    expect(f).not.toContain("old shell output")
  })

  test("reset whose acquire half throws surfaces the error (not a dead snapshot with it swallowed)", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { bumpReset?: () => void } = {}
    const { aframe: frame } = await mountTerminal(<ResetHost harness={harness} api={api} />)
    await frame()
    await act(async () => harness.last().feed("about to die\r\n"))

    harness.failNextAcquire("spawn kobe-shell boom")
    await act(async () => api.bumpReset?.())

    const f = await frame()
    expect(f).toContain("terminal unavailable — shell could not start")
    expect(f).toContain("spawn kobe-shell boom")
    expect(f).not.toContain("about to die")
    // reset() released the old handle before the throw — nothing leaks.
    expect(harness.ptys[0]?.killed).toBe(true)
    expect(harness.registry.size).toBe(0)
  })

  test("confirming reset after a task switch does not reset either terminal", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { switchTo?: (taskId: string, cwd: string) => void } = {}
    const { aframe: frame, mockInput } = await mountTerminal(<SwitchHost harness={harness} api={api} />)
    await frame()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    expect(modalActive()).toBe(true)
    await act(async () => api.switchTo?.("t2", "/wt-1"))
    await frame()
    expect(modalActive()).toBe(true)
    act(() => mockInput.pressEnter())
    await frame()

    expect(modalActive()).toBe(false)
    expect(harness.ptys.length).toBe(2)
    expect(harness.ptys.every((pty) => !pty.killed)).toBe(true)
  })

  test("confirming reset after only the cwd changes leaves the original PTY alive", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { switchTo?: (taskId: string, cwd: string) => void } = {}
    const { aframe: frame, mockInput } = await mountTerminal(<SwitchHost harness={harness} api={api} />)
    await frame()
    const original = harness.last()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    await act(async () => api.switchTo?.("t1", "/wt-2"))
    await frame()
    act(() => mockInput.pressEnter())
    await frame()

    expect(harness.ptys.length).toBe(1)
    expect(original.killed).toBe(false)
  })

  test("F5 confirmation resets an unchanged mounted terminal", async () => {
    const harness = createScriptedPtyRegistry()
    const { aframe: frame, mockInput } = await mountTerminal(
      <Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} />,
    )
    await frame()
    const original = harness.last()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    act(() => mockInput.pressEnter())
    await frame()

    expect(harness.ptys.length).toBe(2)
    expect(original.killed).toBe(true)
    expect(harness.last().killed).toBe(false)
  })

  test("a stale confirmation does not reset a newer PTY under the same task key", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { bumpReset?: () => void } = {}
    const { aframe: frame, mockInput } = await mountTerminal(<ResetHost harness={harness} api={api} />)
    await frame()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    await act(async () => api.bumpReset?.())
    await frame()
    const replacement = harness.last()
    expect(harness.ptys.length).toBe(2)

    act(() => mockInput.pressEnter())
    await frame()

    expect(harness.ptys.length).toBe(2)
    expect(replacement.killed).toBe(false)
  })

  test("confirming reset after Terminal unmounts leaves its PTY alive", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { hide?: () => void } = {}
    const { aframe: frame, mockInput } = await mountTerminal(<UnmountHost harness={harness} api={api} />)
    await frame()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    await act(async () => api.hide?.())
    await frame()
    act(() => mockInput.pressEnter())
    await frame()

    expect(harness.ptys.length).toBe(1)
    expect(harness.last().killed).toBe(false)
  })

  test("a reset after resize applies the current geometry to the fresh PTY", async () => {
    const harness = createScriptedPtyRegistry()
    const {
      aframe: frame,
      mockInput,
      resize,
    } = await mountTerminal(<Terminal cwd="/wt" taskId="t1" focused registry={harness.registry} />)
    await frame()

    act(() => mockInput.pressKey("F5"))
    expect(await frame()).toMatch(/Reset terminal|重置终端/)
    act(() => resize(100, 30))
    await frame()
    const currentGeometry = harness.last().geometry

    act(() => mockInput.pressEnter())
    await frame()

    expect(harness.ptys.length).toBe(2)
    expect(harness.last().geometry).toEqual(currentGeometry)
  })

  test("null cwd renders the no-task placeholder without acquiring", async () => {
    const harness = createScriptedPtyRegistry()
    const { aframe: frame } = await mountTerminal(<Terminal cwd={null} taskId={null} registry={harness.registry} />)
    expect(await frame()).toContain("(no task — press n to create)")
    expect(harness.ptys.length).toBe(0)
  })
})
