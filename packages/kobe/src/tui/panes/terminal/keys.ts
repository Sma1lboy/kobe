/**
 * Terminal pane key bindings — Solid hook layer.
 *
 * The terminal pane is the most "passthrough" of the five panes: when
 * focused, every keystroke (including `ctrl+c` to interrupt the running
 * command, `ctrl+d` to send EOF, arrow keys to navigate the shell's
 * line-editor history) goes to the underlying PTY. We do NOT trap them
 * — with three exceptions.
 *
 * Trapped keys (these stay in kobe and never reach the shell):
 *
 *   - `ctrl+pgup`   — scroll the local scrollback up by one page
 *   - `ctrl+pgdown` — scroll the local scrollback down by one page
 *   - `escape`      — escape hatch: falls through this pane's empty
 *                     handler list and hits the global `focus.detach`
 *                     binding, which returns focus to the sidebar.
 *                     Without this, ctrl+hjkl pane-jump chords also
 *                     pass through to the shell, leaving the terminal
 *                     pane keyboard-only-one-way (mouse-out only).
 *
 * Rationale for the scroll exception: the scrollback view is a
 * kobe-rendered widget, not the live PTY content. Scrolling is a UI
 * gesture, not a shell input. We pick `ctrl+pgup/down` because:
 *   - tmux uses the same chord pair under its prefix for buffer scroll;
 *     the muscle memory transfers.
 *   - bare `pgup`/`pgdown` already mean "scroll the shell's primary
 *     buffer" in many terminals — we leave those for the shell.
 *
 * Rationale for escape: a focused terminal pane forwards every chord
 * the user might press to go elsewhere (ctrl+hjkl, F1, tab, etc.) as
 * raw bytes to the shell. Trapping `esc` and letting the global
 * `focus.detach` handler take over restores keyboard escape from the
 * pane. Cost: shells in vi line-editor mode lose esc as a mode switch.
 * bash/zsh's default emacs mode doesn't use esc; tradeoff judged worth
 * it.
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
  /**
   * Whether the terminal pane is currently selected (border highlight).
   * Used to gate scrollback chord (`ctrl+pgup`/`ctrl+pgdown`) — those
   * stay available in select mode so the user can browse history
   * without engaging the shell.
   */
  focused: Accessor<boolean>
  /**
   * Whether the terminal pane is engaged (mode === "engaged"). Only
   * when engaged does the pane forward keystrokes to the PTY child.
   * In select mode the terminal pane is "passive" — it shows the shell
   * output but doesn't capture input, so global nav chords (ctrl+hjkl,
   * tab, esc) work normally.
   */
  engaged: Accessor<boolean>
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

  // Scroll bindings are available whenever the terminal pane is
  // selected — even in select mode, the user should be able to browse
  // scrollback without engaging the shell.
  const scrollBindings = bindByIds({
    "terminal.scroll-up": () => opts.scroll(-pageSize()),
    "terminal.scroll-down": () => opts.scroll(pageSize()),
  })

  // Passthrough bindings forward every keystroke to the PTY child.
  // ONLY active in engaged mode — in select mode these chords fall
  // through to the global keymap so nav (ctrl+hjkl, tab, esc) works.
  const passthroughBindings: { key: string; cmd: (evt: KeyEvent) => void }[] = []
  for (const name of PASSTHROUGH_NAMES) {
    passthroughBindings.push({
      key: name,
      cmd: (evt) => {
        const bytes = keyEventToShellBytes(evt)
        if (bytes != null) opts.write(bytes)
      },
    })
    passthroughBindings.push({
      key: `ctrl+${name}`,
      cmd: (evt) => {
        const bytes = keyEventToShellBytes(evt)
        if (bytes != null) opts.write(bytes)
      },
    })
  }

  // Two separate binding groups so the gates differ: scroll is on
  // when the pane is selected; passthrough is on only when engaged.
  // Order matters — scroll registers first so `ctrl+pgup`/`ctrl+pgdown`
  // wins over the engaged-mode passthrough variants registered next.
  useBindings(() => ({
    enabled: opts.focused(),
    bindings: scrollBindings,
  }))
  useBindings(() => ({
    enabled: opts.engaged(),
    bindings: passthroughBindings,
  }))
}
