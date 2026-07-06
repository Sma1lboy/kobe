import { afterEach, describe, expect, test } from "vitest"
import { KobeKeymap, bindByIds, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { type Binding, type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

function makeEvt(name: string) {
  let defaultPrevented = false
  return {
    name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault() {
      defaultPrevented = true
    },
  }
}

function fire(handlers: Record<string, Binding["cmd"]>, names: string[]): boolean[] {
  const reg: RegisteredBinding = { id: 1, config: () => ({ bindings: bindByIds(handlers) }) }
  return names.map((name) => dispatchKeyEvent([reg], makeEvt(name)))
}

afterEach(() => {
  resetKeymapToDefaults()
})

describe("slot dispatch parity with default keys", () => {
  test("sidebar.nav: j/down → down, k/up → up", () => {
    const calls: string[] = []
    const handlers = {
      "sidebar.nav": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "down" : "up")
      },
    }
    const handled = fire(handlers, ["j", "k", "down", "up"])
    expect(handled).toEqual([true, true, true, true])
    expect(calls).toEqual(["down", "up", "down", "up"])
  })

  test("files.nav: j/down → down, k/up → up", () => {
    const calls: string[] = []
    const handlers = {
      "files.nav": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "down" : "up")
      },
    }
    fire(handlers, ["j", "k", "down", "up"])
    expect(calls).toEqual(["down", "up", "down", "up"])
  })

  test("files.hierarchy: h/left → collapse, l/right → expand", () => {
    const calls: string[] = []
    const handlers = {
      "files.hierarchy": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "collapse" : "expand")
      },
    }
    fire(handlers, ["h", "l", "left", "right"])
    expect(calls).toEqual(["collapse", "expand", "collapse", "expand"])
  })

  test("sidebar.view and files.tab: [ → prev, ] → next", () => {
    for (const id of ["sidebar.view", "files.tab"]) {
      const calls: number[] = []
      const handlers = {
        [id]: (_evt: unknown, slot?: number) => {
          calls.push((slot ?? 0) % 2 === 0 ? -1 : 1)
        },
      }
      fire(handlers, ["[", "]"])
      expect(calls, id).toEqual([-1, 1])
    }
  })

  test("sidebar.search.nav: down → down, up → up", () => {
    const calls: string[] = []
    const handlers = {
      "sidebar.search.nav": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "down" : "up")
      },
    }
    fire(handlers, ["down", "up"])
    expect(calls).toEqual(["down", "up"])
  })
})

describe("slot dispatch after a user override", () => {
  test("sidebar.nav: [w, e] → w=down, e=up; defaults stop matching", () => {
    const { warnings } = applyKeymapOverrides(KobeKeymap, [{ id: "sidebar.nav", keys: ["w", "e"] }])
    expect(warnings).toEqual([])

    const calls: string[] = []
    const handlers = {
      "sidebar.nav": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "down" : "up")
      },
    }
    const handled = fire(handlers, ["w", "e", "j", "k"])
    expect(handled).toEqual([true, true, false, false])
    expect(calls).toEqual(["down", "up"])
  })

  test("live reload: reset + re-apply re-derives slots from the current keymap", () => {
    applyKeymapOverrides(KobeKeymap, [{ id: "files.hierarchy", keys: ["left", "right"] }])
    expect([...findBinding("files.hierarchy")!.keys]).toEqual(["left", "right"])

    resetKeymapToDefaults()
    const { warnings } = applyKeymapOverrides(KobeKeymap, [{ id: "files.hierarchy", keys: ["left"] }])
    expect(warnings.some((w) => w.includes("keeping the default"))).toBe(true)
    expect([...findBinding("files.hierarchy")!.keys]).toEqual(["h", "l", "left", "right"])

    const calls: string[] = []
    const handlers = {
      "files.hierarchy": (_evt: unknown, slot?: number) => {
        calls.push((slot ?? 0) % 2 === 0 ? "collapse" : "expand")
      },
    }
    fire(handlers, ["h", "l", "left", "right"])
    expect(calls).toEqual(["collapse", "expand", "collapse", "expand"])
  })
})
