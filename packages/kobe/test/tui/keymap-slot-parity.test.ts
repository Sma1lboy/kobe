/**
 * Behavior parity for slot-based dispatch of the direction-multiplexed
 * binding ids (sidebar.nav / files.nav / sidebar.search.nav /
 * files.hierarchy / sidebar.view / files.tab).
 *
 * Before the slot mechanism, the pane handlers discriminated direction by
 * `evt.name` (`if (evt.name === "j" || evt.name === "down") moveDown()`),
 * which made the ids un-rebindable (FIXED_BINDING_IDS): an override would
 * register new chords but the name checks could never match them. The
 * handlers now read the matched chord's SLOT — its index in the id's
 * `keys` array, assigned by `bindByIds` and threaded through
 * `dispatchKeyEvent` — and map `slot % 2` per the SLOT_CONTRACTS pair
 * layouts.
 *
 * These tests pin two invariants:
 *   1. with the DEFAULT keys, slot dispatch is byte-identical to the old
 *      name-based behavior (j/down → down, k/up → up, h/left → collapse,
 *      l/right → expand, [ → prev, ] → next);
 *   2. after a user override (and across the live-reload reset), the slot
 *      layout follows the new chords (`sidebar.nav: [w, s]` → w=down,
 *      s=up) — the whole point of unlocking the ids.
 *
 * The handlers here REPLICATE the slot mapping in
 * `src/tui/panes/sidebar/keys.ts` / `src/tui/panes/filetree/keys.ts` —
 * those modules import `useBindings` (→ @opentui/solid, whose transitive
 * `.scm` assets vitest can't load), so the mapping is asserted via the
 * same `bindByIds` + `dispatchKeyEvent` pipeline production uses with a
 * copy of the one-line slot%2 mapping. If a pane handler's mapping
 * changes, change it here too.
 */

import { afterEach, describe, expect, test } from "vitest"
import { focusSlotIndex } from "../../src/tui-react/workspace/keybinding-gates"
import { KobeKeymap, bindByIds, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { type Binding, type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

function makeEvt(name: string, ctrl = false) {
  let defaultPrevented = false
  return {
    name,
    ctrl,
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

/** Register `handlers` the way a pane does and dispatch each key name. */
function fire(handlers: Record<string, Binding["cmd"]>, names: string[]): boolean[] {
  const reg: RegisteredBinding = { id: 1, config: () => ({ bindings: bindByIds(handlers) }) }
  return names.map((name) => dispatchKeyEvent([reg], makeEvt(name)))
}

// applyKeymapOverrides mutates KobeKeymap in place — restore pristine
// defaults after every test (same discipline as keymap-reload.test.ts).
afterEach(() => {
  resetKeymapToDefaults()
})

describe("slot dispatch parity with default keys", () => {
  test("focus.numeric wraps prefix slots back onto the four pane ordinals", () => {
    const panes = ["sidebar", "workspace", "files", "workspace"] as const
    const calls: string[] = []
    const reg: RegisteredBinding = {
      id: 1,
      config: () => ({
        bindings: bindByIds({
          "focus.numeric": (_evt, slot) => calls.push(panes[focusSlotIndex(slot)] ?? "missing"),
        }),
      }),
    }

    expect(dispatchKeyEvent([reg], makeEvt("a", true))).toBe(true)
    expect(dispatchKeyEvent([reg], makeEvt("h"))).toBe(true)
    expect(dispatchKeyEvent([reg], makeEvt("a", true))).toBe(true)
    expect(dispatchKeyEvent([reg], makeEvt("l"))).toBe(true)
    expect(calls).toEqual(["sidebar", "workspace"])
  })

  test("sidebar.nav: j/down → down, k/up → up", () => {
    const calls: string[] = []
    // Mirrors useSidebarBindings' slot mapping (panes/sidebar/keys.ts).
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
    // Mirrors useFileTreeBindings (panes/filetree/keys.ts).
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
    // `w`/`e` are free in the sidebar scope (`s` would conflict-warn with
    // settings.open.sidebar — conflicts apply anyway, but keep this green).
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
    // Boot override…
    applyKeymapOverrides(KobeKeymap, [{ id: "files.hierarchy", keys: ["left", "right"] }])
    expect([...findBinding("files.hierarchy")!.keys]).toEqual(["left", "right"])

    // …user edits the YAML to an INVALID (odd) count; the reload path
    // resets to defaults first, then re-applies → slot validation re-runs
    // and the default layout survives.
    resetKeymapToDefaults()
    const { warnings } = applyKeymapOverrides(KobeKeymap, [{ id: "files.hierarchy", keys: ["left"] }])
    expect(warnings.some((w) => w.includes("keeping the default"))).toBe(true)
    expect([...findBinding("files.hierarchy")!.keys]).toEqual(["h", "l", "left", "right"])

    // bindByIds re-reads the keymap on every keypress, so dispatch sees
    // the restored defaults — no stale 2-chord slots.
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
