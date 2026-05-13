/**
 * Pure helpers for the terminal pane's key handling.
 *
 * Split out of `keys.ts` so unit tests (which run under Node) can
 * import from here without dragging in `../../lib/keymap` — that
 * module pulls `@opentui/solid`, which transitively loads
 * `@opentui/core`'s native bindings, which need Bun. Same architecture
 * as `panes/sidebar/groups.ts` vs `panes/sidebar/keys.ts`.
 */

import type { KeyEvent } from "@opentui/core"

/**
 * Encode an opentui `KeyEvent` to the byte sequence the shell expects.
 *
 * Where `evt.sequence` is present we forward it verbatim (real
 * keystrokes carry the upstream byte stream there). Synthetic events
 * (notably the ones unit tests build) lack `sequence`; we synthesize
 * the common cases below.
 */
export function keyEventToShellBytes(evt: KeyEvent): string | null {
  const seq = (evt as KeyEvent & { sequence?: string }).sequence
  if (typeof seq === "string" && seq.length > 0) return seq

  const name = evt.name
  if (!name) return null

  switch (name) {
    case "return":
    case "enter":
      return "\r"
    case "tab":
      return "\t"
    case "backspace":
      return "\x7f"
    case "delete":
      return "\x1b[3~"
    case "up":
      return "\x1b[A"
    case "down":
      return "\x1b[B"
    case "right":
      return "\x1b[C"
    case "left":
      return "\x1b[D"
    case "home":
      return "\x1b[H"
    case "end":
      return "\x1b[F"
    case "escape":
      return "\x1b"
    case "space":
      return " "
    default:
      if (name.length === 1) {
        if (evt.ctrl) {
          const lower = name.toLowerCase()
          const code = lower.charCodeAt(0)
          if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60)
        }
        return name
      }
      return null
  }
}

/**
 * Lines per page for `ctrl+pgup` / `ctrl+pgdown` when the consumer
 * doesn't supply a `pageSize` accessor. Picked to match a typical
 * terminal scrollback "page" feel.
 */
export const DEFAULT_PAGE_SIZE = 10

/**
 * Names of keys we trap (do NOT forward to the shell). Re-exported so
 * documentation / tests can assert the list without re-deriving it.
 */
export const TRAPPED_KEYS = ["ctrl+pageup", "ctrl+pagedown"] as const

/**
 * Chord strings the terminal pane must NEVER passthrough to the shell —
 * these are kobe's global escape hatches and have to win against the
 * pane-local PTY forwarder. Without this list, ctrl+hjkl/shift+tab/F1/
 * palette chords get consumed as shell input and the user is trapped
 * inside the terminal pane with no way back to the tasks list.
 *
 * Notes on what's *not* here:
 *   - bare `escape` and `tab` stay as passthrough so vim and shell tab
 *     completion still work inside the embedded terminal.
 *   - `ctrl+pageup`/`ctrl+pagedown` are already trapped earlier in the
 *     same bindings array (scrollback) — first-match-wins handles them.
 */
export const RESERVED_GLOBAL_CHORDS: readonly string[] = [
  // Pane focus (focus.numeric) — primary escape hatch out of the terminal.
  "ctrl+h",
  "ctrl+j",
  "ctrl+k",
  "ctrl+l",
  // Pane cycle (focus.prev). focus.next is bare `tab` and stays passthrough
  // so shell completion works; users get out via shift+tab or ctrl+hjkl.
  "shift+tab",
  // Help / palette / settings.
  "f1",
  "ctrl+p",
  "ctrl+,",
  // Terminal reset — `ctrl+shift+r` kills the current shell and
  // respawns at the worktree. The mnemonic mirrors browser hard-reload
  // (Chrome / Firefox / Edge all use ctrl+shift+r for it), so users
  // already have the muscle memory for "shift means reset, not
  // soft-reload." Initial pass used `alt+r`, but opentui's native
  // debug-overlay handler grabs alt+r before it reaches the JS keymap;
  // ctrl+shift+r is unbound in Windows Terminal / iTerm2 / WT / shell
  // readline alike.
  "ctrl+shift+r",
] as const

/**
 * Names opentui's keypress events use that we want forwarded to the
 * shell when the terminal pane is focused. Lives here (pure) so
 * `keys.ts` (Solid hook) and tests both consume the same source.
 */
export const PASSTHROUGH_NAMES: readonly string[] = [
  // Letters
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  // Digits
  ..."0123456789".split(""),
  // Punctuation
  ..." `~!@#$%^&*()-_=+[]{}\\|;:'\",.<>/?".split(""),
  // Named keys
  "return",
  "enter",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "insert",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]
