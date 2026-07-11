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
 * itself when the child should win. Case today: TerminalTabs' ctrl+w/F2
 * (gate off while the active tab is split so TerminalSplit's leaf-level
 * close/rename fire). Modal barrier vs dialog body is NOT resolved by
 * order anymore — it's declared via `ModalScopeContext` + `modalOwner`
 * below and settled by `insertRegistration`.
 */

import type { KeyEvent, KeyHandler } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { createContext, useContext, useEffect, useRef } from "react"
import {
  type BindingsConfig,
  type RegisteredBinding,
  dispatchKeyEvent,
  insertRegistration,
  resetPrefixState,
} from "../../tui/lib/keymap-dispatch"
import { useLatest } from "../lib/use-latest"

export type { Binding, BindingsConfig, RegisteredBinding } from "../../tui/lib/keymap-dispatch"
export { dispatchKeyEvent } from "../../tui/lib/keymap-dispatch"

/**
 * Modal-scope context: a provider (the dialog overlay) sets a scope token;
 * every `useBindings` mounted inside is stamped as a MEMBER of that scope,
 * and the barrier declares OWNERSHIP via `useBindings`'s `modalOwner`
 * option. `insertRegistration` (keymap-dispatch.ts) then places the barrier
 * below its members no matter which effect committed first — the explicit
 * replacement for the old "sibling order is load-bearing" contract.
 */
export const ModalScopeContext = createContext<symbol | null>(null)

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
  resetPrefixState()
  installedRenderer = renderer
  installed = renderer.keyInput
  listener = (evt: KeyEvent) => {
    dispatchKeyEvent(stack, evt)
  }
  installed.on("keypress", listener)
}

/**
 * True while a modal barrier (the dialog overlay's `ModalBarrier`) is
 * registered. `dispatchKeyEvent` already cuts bindings off at the barrier,
 * but raw `renderer.keyInput` listeners (the terminal pane's catch-all
 * IME/paste forwarder, the sidebar's search capture) bypass dispatch
 * entirely — they must check this, or keys typed into a dialog also land
 * in the PTY / search query behind it. One query so every raw listener
 * honors every dialog, instead of each one re-fixing the bug.
 */
export function modalActive(): boolean {
  return stack.some((r) => r.modalOwner !== undefined)
}

/**
 * Register a set of bindings for the lifetime of the calling component.
 * The `config` function is re-evaluated on every keypress via a ref, so
 * `enabled` flags computed from the latest render stay correct.
 *
 * Modal semantics are declared, not positional: a component inside a
 * `ModalScopeContext` provider registers as a member of that scope; the
 * barrier passes `modalOwner` and is slotted below its members by
 * `insertRegistration`. Both tokens are read at mount (the scope symbol is
 * stable for the provider's lifetime), matching the mount-once effect.
 */
export function useBindings(config: () => BindingsConfig, opts?: { modalOwner?: symbol }): void {
  const renderer = useRenderer()
  ensureInstalled(renderer)

  const configRef = useLatest(config)
  const scope = useContext(ModalScopeContext)

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once registration; scope/owner tokens are stable for the component's lifetime.
  useEffect(() => {
    // Opening a Dialog Stack scope invalidates an in-flight prefix from the
    // surface behind it before any async/mouse transition can leak it back.
    if (opts?.modalOwner !== undefined) resetPrefixState()
    const reg: RegisteredBinding = {
      config: () => configRef.current(),
      id: nextId++,
      modalOwner: opts?.modalOwner,
      // The owner of a scope is not a member of it — it must sit below.
      modalMember: opts?.modalOwner === undefined ? (scope ?? undefined) : undefined,
    }
    insertRegistration(stack, reg)
    return () => {
      const i = stack.findIndex((r) => r.id === reg.id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [])
}
