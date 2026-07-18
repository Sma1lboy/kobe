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

import { defaultChordsOf } from "../../context/keybindings.ts"

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
/**
 * Reservation spec for {@link RESERVED_GLOBAL_CHORDS}. Two entry kinds:
 *
 *   - `{ id }` — a keymap id whose DEFAULT direct chords are reserved via
 *     `defaultChordsOf` (the pristine defaults, NOT the live rows), so
 *     `KobeKeymap` (keybindings-table.ts) stays the single source of truth
 *     and a user override never changes what the terminal swallows.
 *   - a chord literal — reserved even though no keymap row binds it
 *     directly anymore. #308 moved the workspace/chat management chords to
 *     prefix-only (`prefixKeys`), but the terminal passthrough kept
 *     swallowing their old direct chords on main; the literals preserve
 *     that behavior byte-for-byte until the prefix follow-up decides
 *     whether to release them to the PTY (and whether the configured
 *     prefix key itself must be reserved instead).
 *
 * `terminal-keys-pure.test.ts` pins the resolved set.
 */
const RESERVED_SPEC: ReadonlyArray<string | { id: string }> = [
  // THE escape hatch out of the terminal: ctrl+q returns to the tasks
  // list (direct chord restored 2026-07-11, same owner call as the tab
  // rows below).
  { id: "focus.sidebar" }, // ctrl+q
  // Terminal tab management (the PTY chattab, issue #16) — parity with the
  // tmux root key-table which also intercepted these. ctrl+w / f2 double
  // as `workspace.split.close` / `workspace.split.rename` when split —
  // same chords, so one reservation covers both. Direct chords restored
  // as dual aliases beside the prefix strokes (owner call 2026-07-11),
  // so these derive from the table again.
  { id: "chat.tab.new" }, // ctrl+t
  { id: "chat.tab.close" }, // ctrl+w
  { id: "chat.tab.cycle-next" }, // ctrl+]
  { id: "chat.tab.cycle-prev" }, // ctrl+[
  { id: "chat.tab.rename" }, // f2
  // Engine picker / quick-fork (ctrl+e, ctrl+f — prefix-only since #308;
  // without the reservation the embedded terminal forwards them to the
  // engine CLI, e.g. emacs-style forward-char on ctrl+f).
  "ctrl+e", // chat.tab.chooseEngine
  "ctrl+f", // chat.fork.new
  // Split panes inside the tab (tmux % / "): prefix-only since #308.
  // Reserving ctrl+\ costs the embedded shell SIGQUIT — accepted trade,
  // documented in docs/KEYBINDINGS.md.
  "ctrl+\\", // workspace.split.right
  "ctrl+=", // workspace.split.down
  { id: "workspace.split.focus-next" }, // f3 — still a direct default
  // Pane cycle: the one cross-pane chord besides ctrl+q that works from
  // inside the terminal — without it, workspace → files always costs two
  // hops. `tab` itself stays passthrough (shell completion).
  { id: "focus.next" }, // f4
  // Terminal reset (confirm-gated).
  { id: "terminal.reset" }, // f5
  // Zen toggle moved to prefix-only prefix+z (owner call 2026-07-17) —
  // f6 is no longer reserved and passes through to the shell.
  // Jump to the next waiting task. NOT ctrl+g (the engine/readline
  // abort-editing chord) — see docs/KEYBINDINGS.md.
  { id: "attention.next" }, // f7
] as const

export const RESERVED_GLOBAL_CHORDS: readonly string[] = [
  ...new Set(RESERVED_SPEC.flatMap((entry) => (typeof entry === "string" ? [entry] : defaultChordsOf(entry.id)))),
]

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

/** Modifier prefixes the passthrough table expands each name with. */
const PASSTHROUGH_MODIFIER_PREFIXES = ["", "ctrl+", "alt+", "shift+", "ctrl+shift+", "alt+shift+", "ctrl+alt+"] as const

/**
 * The full passthrough chord vocabulary — every `PASSTHROUGH_NAMES ×
 * modifier-prefix` combination minus the kobe-reserved chords. Computed
 * once at module load: the terminal pane re-renders per PTY frame, and
 * rebuilding ~850 chord strings per render was measurable GC pressure
 * on the hottest path.
 */
export const PASSTHROUGH_CHORDS: readonly string[] = PASSTHROUGH_NAMES.flatMap((name) =>
  PASSTHROUGH_MODIFIER_PREFIXES.map((prefix) => `${prefix}${name}`),
).filter((chord) => !RESERVED_GLOBAL_CHORDS.includes(chord))

/**
 * Encode one mouse-wheel tick the way a real terminal emulator would —
 * see `TaskPtyLike.wheel` for the routing contract. Pure: the caller
 * (`XtermTaskPty.wheel`) supplies the mode facts; null means "the app
 * asked for neither", i.e. the caller scrolls its local view.
 */
export function encodeWheel(
  modes: { mouseTracking: boolean; applicationCursorKeys: boolean; alternateScreen: boolean },
  direction: "up" | "down",
  col: number,
  row: number,
): string | null {
  if (modes.mouseTracking) {
    // SGR (1006) wheel encoding — xterm.js doesn't expose which encoding
    // the app negotiated, and every current TUI (claude, vim, less with
    // --mouse) requests SGR, so it's assumed.
    const btn = direction === "up" ? 64 : 65
    return `\x1b[<${btn};${Math.max(1, col)};${Math.max(1, row)}M`
  }
  if (modes.alternateScreen) {
    // Fullscreen app without mouse reporting: the classic emulator
    // fallback of 3 arrow keys per wheel tick.
    const arrow = modes.applicationCursorKeys
      ? direction === "up"
        ? "\x1bOA"
        : "\x1bOB"
      : direction === "up"
        ? "\x1b[A"
        : "\x1b[B"
    return arrow.repeat(3)
  }
  return null
}
