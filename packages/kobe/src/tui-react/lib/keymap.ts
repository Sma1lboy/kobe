/**
 * React key-bindings layer (issue #15, G2) — the `src/tui/lib/keymap.tsx`
 * counterpart for React panes. The dispatcher core (LIFO stack walk, chord
 * matching, preventDefault-on-first-hit) is the shared framework-free
 * `src/tui/lib/keymap-dispatch.ts`; this file owns only registration.
 *
 * Contract parity with the Solid hook:
 *   - `config` is re-evaluated on EVERY keypress. The Solid version relies
 *     on closures over signals staying live; React closures go stale across
 *     renders, so the registered entry reads the LATEST config through a
 *     ref that every render refreshes.
 *   - Bindings stack LIFO; only the topmost enabled match fires.
 *
 * Known ordering difference (documented, accepted for the migration): Solid
 * registers during component SETUP (parents before children → children end
 * up on top); React registers in mount EFFECTS (children before parents →
 * ancestors end up on top). Consequence: a parent and child sharing a chord
 * must resolve by GATING, not stack order — the parent's entry disables
 * itself when the child should win. Cases today: the dialog provider's
 * escape/ctrl+c pair (gates on the dialog stack being non-empty) and
 * TerminalTabs' ctrl+w/F2 (gate off while the active tab is split so
 * TerminalSplit's leaf-level close/rename fire).
 */

import type { KeyEvent, KeyHandler } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef } from "react"
import { type BindingsConfig, type RegisteredBinding, dispatchKeyEvent } from "../../tui/lib/keymap-dispatch"

export type { Binding, BindingsConfig, RegisteredBinding } from "../../tui/lib/keymap-dispatch"
export { dispatchKeyEvent } from "../../tui/lib/keymap-dispatch"

let nextId = 1
const stack: RegisteredBinding[] = []
// Same renderer-swap guard as the Solid layer: production runs one renderer
// per process (no-op from the second call), but a test harness that creates
// a fresh renderer per test in the same process must rebind the listener to
// the new renderer's keyInput emitter.
let installedRenderer: unknown = null
let installed: KeyHandler | null = null
let listener: ((evt: KeyEvent) => void) | null = null
/** Renderers this process has already moved past. A superseded renderer's
 *  tree can keep re-rendering after teardown (pending timers — the test
 *  harness destroys the renderer without unmounting React), and its
 *  useBindings renders must NOT steal the listener back onto a destroyed
 *  renderer and wipe the live stack. Forward-only, like the process. */
const supersededRenderers = new WeakSet<object>()

function ensureInstalled(renderer: ReturnType<typeof useRenderer>): void {
  if (!renderer) {
    throw new Error("useBindings: no renderer in scope; call inside a component rendered by @opentui/react.")
  }
  if (installedRenderer === renderer) return
  if (supersededRenderers.has(renderer as object)) return
  if (installed && listener) installed.off("keypress", listener)
  if (installedRenderer) supersededRenderers.add(installedRenderer as object)
  // New renderer → fresh stack. The old renderer's tree may be torn down
  // without React cleanups (test harness destroy, hard renderer swap) —
  // its entries would linger in the module-global stack forever. Harmless
  // once, but a lingering MODAL barrier (dialog open at teardown) would
  // block every key of the next renderer. Late cleanups from the old tree
  // splice by id and no-op safely against the cleared array.
  stack.length = 0
  installedRenderer = renderer
  installed = renderer.keyInput
  listener = (evt: KeyEvent) => {
    dispatchKeyEvent(stack, evt)
  }
  installed.on("keypress", listener)
}

/**
 * Register a set of bindings for the lifetime of the calling component.
 * The `config` function is re-evaluated on every keypress via a ref, so
 * `enabled` flags computed from the latest render stay correct.
 */
export function useBindings(config: () => BindingsConfig): void {
  const renderer = useRenderer()
  ensureInstalled(renderer)

  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    const reg: RegisteredBinding = { config: () => configRef.current(), id: nextId++ }
    stack.push(reg)
    return () => {
      const i = stack.findIndex((r) => r.id === reg.id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [])
}
