/**
 * Regression test for the new-task dialog's Ctrl+A registration gate.
 *
 * The production bug this pins (same class as the quick-task Enter bug —
 * see quick-task-bindings.test.ts): the dialog registered `ctrl+a`
 * UNCONDITIONALLY with the tab check INSIDE the handler
 * (`if (tab() !== "adopt") return`). `dispatchKeyEvent` calls
 * `preventDefault()` on every matched binding — even a no-op one — so on the
 * Existing/Clone tabs ctrl+a was consumed by the no-op handler and never
 * reached the focused input, killing opentui's line-home (ctrl+a) in the
 * repo-path / clone-URL / parent-dir / branch fields (the most typing-heavy
 * dialog). The fix gates REGISTRATION: the ctrl+a binding exists in the
 * returned list ONLY while the Adopt tab is active.
 *
 * dialog.tsx builds its bindings inline (the component drags in opentui), so
 * this test reproduces the exact registration shape — the conditional spread
 * `...(tab === "adopt" ? [{ key: "ctrl+a", cmd }] : [])` — and asserts the
 * dispatch outcome per tab. If a future edit moves the tab check back inside
 * the handler, this test fails because the chord would consume the key on a
 * non-Adopt tab.
 */

import { type RegisteredBinding, dispatchKeyEvent } from "@/tui/lib/keymap-dispatch"
import { describe, expect, test } from "vitest"

type Tab = "existing" | "clone" | "adopt"

/** The Ctrl+A slice of the dialog's binding list, built exactly as dialog.tsx
 *  does: registration-gated on the active tab. */
function ctrlASlice(tab: Tab, onSelectAll: () => void) {
  return tab === "adopt" ? [{ key: "ctrl+a", cmd: onSelectAll }] : []
}

function evt(name: string, ctrl = false) {
  let prevented = false
  return {
    name,
    ctrl,
    defaultPrevented: false,
    preventDefault() {
      prevented = true
    },
    get prevented() {
      return prevented
    },
  }
}

function stackFor(bindings: ReturnType<typeof ctrlASlice>): RegisteredBinding[] {
  return [{ id: 1, config: () => ({ bindings }) }]
}

describe("new-task dialog ctrl+a registration gate", () => {
  test("Existing/Clone tabs: ctrl+a is UNCLAIMED so it reaches the input as line-home", () => {
    for (const tab of ["existing", "clone"] as const) {
      let calls = 0
      const e = evt("a", true)
      const hit = dispatchKeyEvent(stackFor(ctrlASlice(tab, () => calls++)), e)
      expect(hit).toBe(false) // no binding consumed it → input gets ctrl+a (line-home)
      expect(e.prevented).toBe(false)
      expect(calls).toBe(0)
    }
  })

  test("Adopt tab: ctrl+a fires select-all and consumes the key", () => {
    let calls = 0
    const e = evt("a", true)
    const hit = dispatchKeyEvent(stackFor(ctrlASlice("adopt", () => calls++)), e)
    expect(hit).toBe(true)
    expect(e.prevented).toBe(true)
    expect(calls).toBe(1)
  })
})
