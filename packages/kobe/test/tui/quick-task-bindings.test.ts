import { describe, expect, test } from "vitest"
import { quickTaskBindings } from "../../src/tui/component/quick-task-bindings"
import { type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"

const handlers = () => {
  const calls: string[] = []
  return {
    calls,
    h: {
      cycleField: (d: 1 | -1) => calls.push(`cycle:${d}`),
      stepEngine: (d: 1 | -1) => calls.push(`engine:${d}`),
      commit: () => calls.push("commit"),
      pasteAttachment: () => calls.push("paste"),
      removeLastAttachment: () => calls.push("unattach"),
    },
  }
}

function evt(name: string, mods: { ctrl?: boolean } = {}) {
  let prevented = false
  return {
    name,
    ctrl: mods.ctrl ?? false,
    defaultPrevented: false,
    preventDefault() {
      prevented = true
    },
    get prevented() {
      return prevented
    },
  }
}

function stackFor(bindings: ReturnType<typeof quickTaskBindings>): RegisteredBinding[] {
  return [{ id: 1, config: () => ({ bindings }) }]
}

describe("quickTaskBindings field gating", () => {
  test("prompt field: enter is UNCLAIMED so it reaches the input's onSubmit", () => {
    const { calls, h } = handlers()
    const e = evt("return")
    const hit = dispatchKeyEvent(stackFor(quickTaskBindings("prompt", h)), e)
    expect(hit).toBe(false)
    expect(e.prevented).toBe(false)
    expect(calls).toEqual([])
  })

  test("prompt/branch fields: arrow keys are unclaimed so the input cursor moves", () => {
    const { h } = handlers()
    for (const field of ["prompt", "branch"] as const) {
      expect(dispatchKeyEvent(stackFor(quickTaskBindings(field, h)), evt("left"))).toBe(false)
      expect(dispatchKeyEvent(stackFor(quickTaskBindings(field, h)), evt("right"))).toBe(false)
    }
  })

  test("engine field: enter commits, arrows cycle the engine", () => {
    const { calls, h } = handlers()
    const bindings = quickTaskBindings("engine", h)
    expect(dispatchKeyEvent(stackFor(bindings), evt("return"))).toBe(true)
    expect(dispatchKeyEvent(stackFor(bindings), evt("left"))).toBe(true)
    expect(dispatchKeyEvent(stackFor(bindings), evt("right"))).toBe(true)
    expect(calls).toEqual(["commit", "engine:-1", "engine:1"])
  })

  test("attachment chords (ctrl+v / ctrl+x) are claimed on every field", () => {
    const { calls, h } = handlers()
    for (const field of ["prompt", "engine", "branch"] as const) {
      expect(dispatchKeyEvent(stackFor(quickTaskBindings(field, h)), evt("v", { ctrl: true }))).toBe(true)
      expect(dispatchKeyEvent(stackFor(quickTaskBindings(field, h)), evt("x", { ctrl: true }))).toBe(true)
    }
    expect(calls).toEqual(["paste", "unattach", "paste", "unattach", "paste", "unattach"])
  })

  test("field cycling and ctrl+e work from every field", () => {
    const { calls, h } = handlers()
    for (const field of ["prompt", "engine", "branch"] as const) {
      dispatchKeyEvent(stackFor(quickTaskBindings(field, h)), evt("tab"))
    }
    expect(calls).toEqual(["cycle:1", "cycle:1", "cycle:1"])
  })
})
