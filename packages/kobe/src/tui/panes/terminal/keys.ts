/**
 * Terminal pane key bindings — Solid hook layer.
 *
 * The terminal pane is the most "passthrough" of the five panes: when
 * focused, every keystroke (including `ctrl+c` to interrupt the running
 * command, `ctrl+d` to send EOF, arrow keys to navigate the shell's
 * line-editor history) goes to the underlying PTY. We do NOT trap them.
 *
 * Exception list (these stay in kobe and never reach the shell):
 *
 *   - `ctrl+pgup`   — scroll the local scrollback up by one page
 *   - `ctrl+pgdown` — scroll the local scrollback down by one page
 *   - `RESERVED_GLOBAL_CHORDS` (in `./keys-pure.ts`) — chords that must
 *     stay reachable as kobe-global escape hatches when the terminal is
 *     focused: `ctrl+h/j/k/l` (pane focus), `shift+tab` (pane cycle prev),
 *     `f1` / `ctrl+p` / `ctrl+,` (help, palette, settings). Without
 *     skipping these, the user is trapped inside the terminal pane with
 *     no way back to the tasks list.
 *
 * Rationale for the exception: the scrollback view is a kobe-rendered
 * widget, not the live shell PTY content. Scrolling is a UI gesture,
 * not a shell input. Without these we'd never be able to see history
 * once it scrolled past the visible viewport. We pick `ctrl+pgup/down`
 * because:
 *   - `ctrl+pgup/down` is unlikely to collide with normal shell input.
 *   - bare `pgup`/`pgdown` already mean "scroll the shell's primary
 *     buffer" in many terminals — we leave those for the shell.
 *
 * Focus gating: the bindings are scoped via `enabled = focused()`. When
 * a sibling pane is focused, even our exception keys pass through the
 * Solid keymap layer untouched.
 *
 * Pure/runtime split: the pure encoder + constants live in
 * `./keys-pure.ts` so unit tests under Node can import them. This
 * file owns the Solid hook and the bindings table.
 */

import type { KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, onCleanup } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import {
  DEFAULT_PAGE_SIZE,
  PASSTHROUGH_NAMES,
  RESERVED_GLOBAL_CHORDS,
  TRAPPED_KEYS,
  keyEventToShellBytes,
} from "./keys-pure"

// Re-export pure helpers so callers can import everything from one path.
export { DEFAULT_PAGE_SIZE, TRAPPED_KEYS, keyEventToShellBytes }

/**
 * Argument bag for {@link useTerminalBindings}. The Solid component
 * owns the focus signal and the scroll state; this hook bridges
 * keystrokes into the right channel.
 */
export type TerminalBindingsOpts = {
  /** Whether the terminal pane currently has focus. */
  focused: Accessor<boolean>
  /** Forward a byte sequence to the underlying PTY. */
  write: (data: string) => void
  /** Scroll the local scrollback view by N lines (negative = up). */
  scroll: (lines: number) => void
  /** How many lines `ctrl+pgup`/`ctrl+pgdown` move per press. */
  pageSize?: Accessor<number>
  /**
   * Tear down the current PTY and spawn a fresh shell at the same
   * worktree. Fires from `F5` after the user confirms; the
   * component owns the confirm dialog because it has the
   * `useDialog()` context.
   */
  reset: () => void
}

/**
 * Register the terminal pane's pane-local bindings.
 *
 * The hook claims `ctrl+pgup` / `ctrl+pgdown` for scrollback, then
 * registers passthrough bindings for every key opentui dispatches as
 * `keypress`. Modifier combos (ctrl+letter, etc.) are handled because
 * the keymap matches `ctrl+<name>` when `evt.ctrl` is true; we register
 * both bare and `ctrl+`-prefixed forms.
 *
 * The `keys-pure.ts::PASSTHROUGH_NAMES` list is the union of
 * alphanumerics + named keys opentui can dispatch. Any name not in the
 * list won't be forwarded — but `evt.sequence` covers the gaps for
 * rare inputs because real terminal keystrokes carry their byte
 * stream there.
 */
export function useTerminalBindings(opts: TerminalBindingsOpts): void {
  const pageSize = () => opts.pageSize?.() ?? DEFAULT_PAGE_SIZE

  const bindings: { key: string; cmd: (evt: KeyEvent) => void }[] = []

  // Scrollback exceptions FIRST so they take precedence over any
  // passthrough variants of `pageup`/`pagedown` registered later in
  // the table. Chord strings come from KobeKeymap via bindByIds so
  // this pane stays in sync with the central registry.
  bindings.push(
    ...bindByIds({
      "terminal.scroll-up": () => opts.scroll(-pageSize()),
      "terminal.scroll-down": () => opts.scroll(pageSize()),
      "terminal.reset": () => opts.reset(),
    }),
  )

  const reserved = new Set<string>(RESERVED_GLOBAL_CHORDS)
  const forward = (evt: KeyEvent): void => {
    const bytes = keyEventToShellBytes(evt)
    if (bytes != null) opts.write(bytes)
  }
  for (const name of PASSTHROUGH_NAMES) {
    // Register the bare name plus every modifier form the keymap can mint
    // (ctrl+/alt+/shift+/meta combos) — modifier chords must WIN the LIFO
    // stack against kobe's global bindings so the engine CLI receives its
    // own shortcuts (shift+tab plan-mode, alt+enter, ctrl+r history…).
    // Shift on printable characters never minted a chord (terminals send
    // the shifted glyph), so shift+ registrations only matter for named keys.
    for (const prefix of ["", "ctrl+", "alt+", "shift+", "ctrl+shift+", "alt+shift+", "ctrl+alt+"]) {
      const chord = `${prefix}${name}`
      if (reserved.has(chord)) continue
      bindings.push({ key: chord, cmd: forward })
    }
  }

  useBindings(() => ({
    enabled: opts.focused(),
    bindings,
  }))

  // Catch-all input forwarder.
  //
  // The bindings table above only matches keys whose `name` is in
  // `PASSTHROUGH_NAMES` (ASCII letters / digits / punctuation / named
  // keys). IME / pinyin composition commits arrive as keypress events
  // whose `name` is the composed character itself (e.g. "你"), which no
  // binding matches — so without this they were silently dropped.
  //
  // We listen at the raw keypress level and forward anything the keymap
  // stack did NOT already consume. `dispatchKeyEvent` calls
  // `preventDefault()` on every hit, and the global keymap listener runs
  // before this one, so:
  //   - keys handled by a binding (passthrough ASCII, scrollback, reset,
  //     AND global escape chords like ctrl+q) are `defaultPrevented` →
  //     skipped here. That's why ctrl+q still escapes to the sidebar.
  //   - everything else (CJK / IME / any non-enumerated input) carries
  //     its bytes in `sequence` and is forwarded to the PTY.
  const renderer = useRenderer()
  const forwardUnhandled = (evt: KeyEvent) => {
    if (!opts.focused() || evt.defaultPrevented) return
    const bytes = keyEventToShellBytes(evt)
    if (bytes == null) return
    opts.write(bytes)
    evt.preventDefault()
  }
  renderer.keyInput.on("keypress", forwardUnhandled)
  onCleanup(() => {
    renderer.keyInput.off("keypress", forwardUnhandled)
  })
}
