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
 * Kitty keyboard-protocol CSI-u sequence (e.g. ctrl+c = `\x1b[99;5u`,
 * esc = `\x1b[27u`). The host renderer enables kitty
 * (`useKittyKeyboard` in host-render-options.ts), so on kitty-capable
 * terminals modifier chords and esc arrive CSI-u encoded on the wire.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw ESC-prefixed kitty wire encoding is the whole point
const KITTY_CSI_U_RE = /^\x1b\[[\d:;]*u$/

/** Classic C0 mappings for ctrl+punctuation (ctrl+\ = SIGQUIT etc.). */
const CTRL_PUNCT_C0: Record<string, string> = {
  "@": "\x00",
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  _: "\x1f",
  "?": "\x7f",
}

/**
 * Encode an opentui `KeyEvent` to the byte sequence the shell expects.
 *
 * Where the keystroke arrived as legacy bytes we forward `evt.sequence`
 * verbatim. Kitty CSI-u keystrokes must be re-encoded: the embedded PTY
 * never negotiated kitty, and opentui's parser makes `sequence`
 * unusable for them — measured on the real wire:
 * ctrl+c ⇒ `{ raw: "\x1b[99;5u", sequence: "c" }` (forwarding sequence
 * types a literal "c"!) while esc ⇒ `{ raw: "\x1b[27u", sequence:
 * "\x1b[27u" }` (forwarding sends garbage). So if EITHER field is
 * CSI-u shaped we synthesize from name+modifiers instead. Synthetic
 * events (unit tests) lack `sequence` and take the same synthesis path.
 */
export function keyEventToShellBytes(evt: KeyEvent): string | null {
  const e = evt as KeyEvent & { sequence?: string; raw?: string }
  const seq = typeof e.sequence === "string" && e.sequence.length > 0 ? e.sequence : null
  const kittyWire =
    (typeof e.raw === "string" && KITTY_CSI_U_RE.test(e.raw)) || (seq != null && KITTY_CSI_U_RE.test(seq))
  if (seq != null && !kittyWire) return seq
  return synthesizeShellBytes(evt)
}

function synthesizeShellBytes(evt: KeyEvent): string | null {
  const name = evt.name
  if (!name) return null

  // Modifier synthesis for synthetic events (real keystrokes carry
  // `sequence`): shift+tab is the back-tab CSI claude's plan-mode cycle
  // expects; alt+<key> is ESC-prefixed per xterm convention.
  if (evt.shift && name === "tab") return "\x1b[Z"
  if (evt.option || evt.meta) {
    const inner = synthesizeShellBytes({ ...evt, option: false, meta: false } as KeyEvent)
    return inner == null ? null : `\x1b${inner}`
  }

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
      return evt.ctrl ? "\x00" : " "
    default:
      if (name.length === 1) {
        if (evt.ctrl) {
          const lower = name.toLowerCase()
          const code = lower.charCodeAt(0)
          if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60)
          const c0 = CTRL_PUNCT_C0[name]
          if (c0 != null) return c0
          // Unknown ctrl chord: dropping beats typing a stray literal.
          return null
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
 * Chord strings the terminal pane must NEVER passthrough to the shell.
 * Deliberately MINIMAL: the engine CLI owns
 * its own chords (shift+tab plan-mode, ctrl+r history, ctrl+hjkl, F1…),
 * so kobe keeps only ctrl+q as the escape hatch plus the tab-management
 * and reset chords. Kobe's other global chords stay reachable from every
 * non-terminal pane.
 *
 * Notes on what's *not* here:
 *   - bare `escape` and `tab` stay as passthrough so vim and shell tab
 *     completion still work inside the embedded terminal.
 *   - `ctrl+pageup`/`ctrl+pagedown` are already trapped earlier in the
 *     same bindings array (scrollback) — first-match-wins handles them.
 */
export const RESERVED_GLOBAL_CHORDS: readonly string[] = [
  // THE escape hatch out of the terminal: from anywhere inside
  // the engine CLI, ctrl+q returns to the tasks list. Everything else the
  // engine may want (shift+tab plan-mode, ctrl+hjkl, f1, ctrl+p, ctrl+,)
  // now PASSES THROUGH — kobe must not eat the
  // engine's own chords; kobe-global chords remain available from every
  // other pane.
  "ctrl+q",
  // Terminal tab management (the PTY chattab, issue #16) — parity with the
  // tmux root key-table which also intercepted these.
  "ctrl+t",
  "ctrl+w",
  "ctrl+]",
  "ctrl+[",
  "f2",
  // Engine picker for a new chat tab (tmux's `ctrl+shift+t` equivalent —
  // ctrl+e instead, since the keymap layer can't distinguish shift+letter
  // from the bare letter).
  "ctrl+e",
  // Quick-fork (chat.fork.new, KOB-74/issue #17): opens the quick-task
  // composer seeded from the active task. Same reservation shape as ctrl+e —
  // without it the embedded terminal forwards ctrl+f to the engine CLI
  // (emacs-style forward-char) and the binding never fires.
  "ctrl+f",
  // Split panes inside the tab (tmux % / "): ctrl+\ splits right (the
  // glyph is a vertical divider), ctrl+= splits down (horizontal strokes),
  // f3 cycles pane focus (tmux prefix+o). Reserving ctrl+\ costs the
  // embedded shell SIGQUIT — accepted trade, documented in
  // docs/KEYBINDINGS.md. Both chords need the kitty keyboard protocol
  // (legacy terminals cannot encode ctrl+= at all).
  "ctrl+\\",
  "ctrl+=",
  "f3",
  // Pane cycle (`focus.next`): the one cross-pane chord besides ctrl+q
  // that works from inside the terminal — without it, workspace → files
  // always costs two hops (ctrl+q, then ctrl+k). `tab` itself stays
  // passthrough (shell completion); F4 fills the F2/F3/F5 row.
  "f4",
  // Terminal reset (confirm-gated).
  "f5",
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
