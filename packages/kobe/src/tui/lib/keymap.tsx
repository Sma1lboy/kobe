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

export type RegisteredBinding = {
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

  // Modifier mapping rules (the *only* place chord prefixes are minted):
  //   - `evt.ctrl`   → `ctrl+`. Universal across terminals.
  //   - `evt.meta`   → `cmd+`. The Command key on macOS / Win key on Windows.
  //                    Most terminals do NOT forward this — Cmd+C is normally
  //                    eaten by the terminal emulator itself for native copy.
  //                    Kitty / Ghostty / iTerm2 *can* be configured to forward
  //                    it; when they do, kobe sees `meta=true`. We keep `cmd+`
  //                    as a separate prefix from `alt+` so a Cmd+X chord that
  //                    leaks into the app doesn't accidentally fire an
  //                    Option+X binding (the previous code aliased both to
  //                    `alt+`, which made `cmd+p`/`cmd+k` bindings in
  //                    KobeKeymap silently dead — KOB key-routing fix).
  //   - `evt.option` → `alt+`. Option on macOS / Alt elsewhere. macOS Option+K
  //                    arrives as `ESC k` which opentui surfaces as
  //                    `option=true`, name=`k` → `alt+k`.
  //   - shift+letter is just uppercase, so we only emit `shift+` for
  //     non-letter keys (`shift+tab`, `shift+enter`, etc.).
  const mods: string[] = []
  if (evt.ctrl) mods.push("ctrl")
  if (evt.meta) mods.push("cmd")
  if (evt.option) mods.push("alt")
  if (evt.shift && name && name.length > 1) mods.push("shift")

  if (mods.length === 0) return base
  const prefix = `${mods.join("+")}+`
  // When modifiers are present, return ONLY the prefixed forms. A plain
  // `{ key: "k" }` binding must NOT catch `ctrl+k` — otherwise pane-local
  // bindings (sidebar j/k) shadow global chords (`ctrl+k` palette).
  // Bindings that want both behaviors must register both keys explicitly.
  return base.map((n) => prefix + n)
}

/**
 * Walk the binding stack top-down and fire the first matching binding.
 * Returns true if a binding was fired (caller can inspect this; the
 * production listener uses it to short-circuit). On a hit, the event's
 * `preventDefault()` is called so opentui's native widgets (e.g. the
 * textarea's onSubmit) don't also receive the key in the same tick.
 *
 * Pulled out of the listener body so unit tests can exercise the
 * dispatch logic against a fake stack + KeyEvent-shaped object without
 * needing a real renderer.
 */
export function dispatchKeyEvent(
  bindingStack: readonly RegisteredBinding[],
  evt: { defaultPrevented: boolean; preventDefault(): void; name?: string; ctrl?: boolean; meta?: boolean; option?: boolean; shift?: boolean },
): boolean {
  if (evt.defaultPrevented) return false
  const candidates = matchKey(evt as KeyEvent)
  for (let i = bindingStack.length - 1; i >= 0; i--) {
    const reg = bindingStack[i]
    if (!reg) continue
    const cfg = reg.config()
    if (cfg.enabled === false) continue
    const hit = cfg.bindings.find((b) => candidates.includes(b.key))
    if (hit) {
      hit.cmd(evt as KeyEvent)
      // Consume the event so native widgets (e.g. opentui's textarea
      // onSubmit) don't also receive it in the same tick. Without this,
      // an Enter that fires `sidebar.select` — whose handler pulls
      // focus to the workspace — would then ALSO submit the
      // freshly-focused composer's draft.
      evt.preventDefault()
      return true
    }
  }
  return false
}

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
