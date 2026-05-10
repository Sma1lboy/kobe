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
 *
 * Rationale for the exception: the scrollback view is a kobe-rendered
 * widget, not the live tmux pane content. Scrolling is a UI gesture,
 * not a shell input. Without these we'd never be able to see history
 * once it scrolled past the visible viewport. We pick `ctrl+pgup/down`
 * because:
 *   - tmux uses the same chord pair under its prefix for buffer scroll;
 *     the muscle memory transfers.
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
import type { Accessor } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import { DEFAULT_PAGE_SIZE, PASSTHROUGH_NAMES, TRAPPED_KEYS, keyEventToShellBytes } from "./keys-pure"

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
    }),
  )

  for (const name of PASSTHROUGH_NAMES) {
    bindings.push({
      key: name,
      cmd: (evt) => {
        const bytes = keyEventToShellBytes(evt)
        if (bytes != null) opts.write(bytes)
      },
    })
    bindings.push({
      key: `ctrl+${name}`,
      cmd: (evt) => {
        const bytes = keyEventToShellBytes(evt)
        if (bytes != null) opts.write(bytes)
      },
    })
  }

  useBindings(() => ({
    enabled: opts.focused(),
    bindings,
  }))
}
