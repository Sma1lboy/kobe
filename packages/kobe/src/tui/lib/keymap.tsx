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

export type Binding = {
  key: string
  cmd: (event: KeyEvent) => void
}

export type BindingsConfig = {
  enabled?: boolean
  bindings: Binding[]
}

type RegisteredBinding = {
  config: () => BindingsConfig
  id: number
}

let nextId = 1
const stack: RegisteredBinding[] = []
let installed: KeyHandler | null = null
let listener: ((evt: KeyEvent) => void) | null = null

/**
 * Build a normalized match key for a `KeyEvent`. Mirrors the chord shape
 * opencode bindings use ("ctrl+c", "shift+tab", "k").
 */
function matchKey(evt: KeyEvent): string[] {
  // opentui's KeyEvent has `name` (e.g. "k", "escape", "return") plus modifier
  // booleans. We build a few candidate strings so a binding registered as
  // either "return" or "enter" still fires; opencode dialogs use both names.
  const base: string[] = []
  const name = evt.name
  if (name) base.push(name)
  if (name === "return") base.push("enter")
  if (name === "enter") base.push("return")

  const mods: string[] = []
  if (evt.ctrl) mods.push("ctrl")
  if (evt.meta) mods.push("alt")
  if (evt.option) mods.push("alt")
  if (evt.shift && name && name.length > 1) mods.push("shift") // shift+letter is just uppercase, skip

  if (mods.length === 0) return base
  const prefix = `${mods.join("+")}+`
  // When modifiers are present, return ONLY the prefixed forms. A plain
  // `{ key: "k" }` binding must NOT catch `ctrl+k` — otherwise pane-local
  // bindings (sidebar j/k) shadow global chords (`ctrl+k` palette).
  // Bindings that want both behaviors must register both keys explicitly.
  return base.map((n) => prefix + n)
}

function ensureInstalled() {
  if (installed) return
  const renderer = useRenderer()
  if (!renderer) {
    throw new Error("useBindings: no renderer in scope; call inside a component rendered by @opentui/solid.")
  }
  installed = renderer.keyInput
  listener = (evt: KeyEvent) => {
    if (evt.defaultPrevented) return
    const candidates = matchKey(evt)
    // walk top-down; first match wins
    for (let i = stack.length - 1; i >= 0; i--) {
      const reg = stack[i]
      if (!reg) continue
      const cfg = reg.config()
      if (cfg.enabled === false) continue
      const hit = cfg.bindings.find((b) => candidates.includes(b.key))
      if (hit) {
        hit.cmd(evt)
        return
      }
    }
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
