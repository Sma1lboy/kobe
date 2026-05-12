/**
 * Minimal key bindings layer for kobe's TUI.
 *
 * Stand-in for opencode's `@opentui/keymap` integration (which we don't ship
 * because it pulls the whole opencode plugin/command/leader machinery). The
 * shape of `useBindings` is intentionally compatible with opencode's so that
 * lifted dialogs (DialogConfirm, DialogAlert, DialogDiff) can call it without
 * modification:
 *
 *   useBindings(() => ({
 *     enabled: someSignal(),
 *     bindings: [{ key: "escape", cmd: () => ... }],
 *   }))
 *
 * Differences from opencode:
 *   - No leader sequences, no `cmd-k` style chord matching, no command
 *     namespaces. Single-key + a few common modifiers (ctrl, shift, alt).
 *   - Bindings are stacked LIFO; only the topmost enabled binding for a given
 *     key fires (same precedence model dialogs assume).
 *   - The match key is the opentui `KeyEvent.name` (e.g. "escape", "k") with
 *     optional `ctrl+`, `shift+`, `alt+` prefixes.
 *
 * This is enough for the dialog stack and a handful of global hotkeys. When
 * Wave 1 stream D wires real keybindings we'll either keep extending this or
 * swap to `@opentui/keymap` if the dependency surface stabilizes.
 */

import type { KeyEvent, KeyHandler } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, onCleanup } from "solid-js"
import { type BindingsConfig, type RegisteredBinding, dispatchKeyEvent } from "./keymap-dispatch"

// Pure types + dispatch logic live in ./keymap-dispatch so vitest can
// exercise them without importing @opentui/solid (whose transitive
// `.scm` asset imports vitest's node loader can't resolve).
export type { Binding, BindingsConfig, RegisteredBinding } from "./keymap-dispatch"
export { dispatchKeyEvent } from "./keymap-dispatch"

let nextId = 1
const stack: RegisteredBinding[] = []
let installed: KeyHandler | null = null
let listener: ((evt: KeyEvent) => void) | null = null

function ensureInstalled() {
  if (installed) return
  const renderer = useRenderer()
  if (!renderer) {
    throw new Error("useBindings: no renderer in scope; call inside a component rendered by @opentui/solid.")
  }
  installed = renderer.keyInput
  listener = (evt: KeyEvent) => {
    dispatchKeyEvent(stack, evt)
  }
  installed.on("keypress", listener)
}

/**
 * Register a set of bindings for the lifetime of the calling component.
 * The `config` function may close over signals — it is re-evaluated on every
 * keypress, so reactive `enabled` flags work.
 */
export function useBindings(config: () => BindingsConfig): void {
  ensureInstalled()
  const id = nextId++
  const reg: RegisteredBinding = { config, id }

  // Touch the config once inside an effect so Solid sees the dependency graph;
  // this also makes the binding "live" for HMR re-runs.
  createEffect(() => {
    void config()
  })

  stack.push(reg)
  onCleanup(() => {
    const i = stack.findIndex((r) => r.id === id)
    if (i >= 0) stack.splice(i, 1)
  })
}

/**
 * Hook for tests / debugging. Returns the number of currently active binding
 * groups in the stack.
 */
export function _bindingStackSize(): number {
  return stack.length
}
