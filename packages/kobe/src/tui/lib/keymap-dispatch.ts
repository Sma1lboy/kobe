/**
 * Pure dispatch logic for kobe's TUI keymap.
 *
 * Split out of `keymap.tsx` so unit tests can exercise the binding-
 * stack precedence + preventDefault behavior without pulling in
 * `@opentui/solid` (whose transitive `.scm` asset imports vitest's
 * node loader can't resolve). The Solid hook + renderer-install side
 * lives in `keymap.tsx` and re-exports from here for the rest of the
 * codebase.
 */

import type { KeyEvent } from "@opentui/core"

export type Binding = {
  key: string
  /**
   * Handler. The second argument is the binding's {@link Binding.slot} —
   * present when the registration site assigned one (`bindByIds` does).
   * Single-chord handlers can ignore it; multiplexed handlers (one id,
   * several chords, direction decided by WHICH chord fired) read it
   * instead of `event.name`, so user-rebound chords keep working.
   */
  cmd: (event: KeyEvent, slot?: number) => void
  /**
   * Positional index of `key` within the owning binding id's `keys` array
   * at registration time (slot-based dispatch). `bindByIds` fills this in;
   * hand-rolled `{ key, cmd }` literals may omit it. The slot is what lets
   * a handler like `sidebar.nav` map "which chord fired" → "which
   * direction" without inspecting `event.name` — the contract that makes
   * direction-multiplexed ids user-rebindable (see SLOT_CONTRACTS in
   * keymap-overrides.ts for the per-id slot layouts).
   */
  slot?: number
}

export type BindingsConfig = {
  enabled?: boolean
  bindings: Binding[]
}

export type RegisteredBinding = {
  config: () => BindingsConfig
  id: number
}

/**
 * Build a normalized match key for a `KeyEvent`. Mirrors the chord shape
 * opencode bindings use ("ctrl+c", "shift+tab", "k").
 */
export function matchKey(evt: KeyEvent): string[] {
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
 */
export function dispatchKeyEvent(
  bindingStack: readonly RegisteredBinding[],
  evt: {
    defaultPrevented: boolean
    preventDefault(): void
    name?: string
    ctrl?: boolean
    meta?: boolean
    option?: boolean
    shift?: boolean
  },
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
      hit.cmd(evt as KeyEvent, hit.slot)
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
