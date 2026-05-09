/**
 * Central global keybindings for kobe.
 *
 * Stream D wires top-level shortcuts (palette, help, focus cycling, quit,
 * universal cancel). Pane-local bindings register their own scoped keymap
 * downstream — e.g. the chat composer owns its own `enter` / `shift+enter`,
 * the sidebar owns its `j/k`. **This file is global bindings only.**
 *
 * The shape:
 *   - `KobeKeymap` is a static, declarative table read by the help dialog
 *     and consumed by `useKobeKeybindings()` to register live handlers via
 *     the local `useBindings` hook (`src/tui/lib/keymap.tsx`).
 *   - `useKobeKeybindings()` is a Solid hook — call it inside a component
 *     mounted under `DialogProvider` + `CommandPaletteProvider`. It depends
 *     on those contexts. The bindings are torn down when the component
 *     unmounts (via `onCleanup` inside `useBindings`).
 *
 * Cmd vs Ctrl on macOS: terminals don't propagate the Command key to the
 * PTY. We register both `ctrl+k` and `alt+k` so the same key path works
 * across configurations (Option+K on macOS sends `ESC k` which our
 * keymap layer surfaces as `alt+k`). When users want a true `cmd+k`, they
 * configure their terminal to send Option+K or Ctrl+K instead.
 *
 * `tab` / `shift+tab` are reserved here for pane focus cycling but the
 * actual focus model lands in Wave 3. We register no-op handlers so the
 * keys aren't swallowed by other handlers in the meantime — once the
 * focus manager exists, we replace the `cmd` callbacks via this same
 * table.
 */

import { createMemo } from "solid-js"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { type CommandPaletteContext, useCommandPalette } from "./command-palette"

/**
 * A global binding row. `keys` lists every chord that triggers the action
 * (we register them all — terminals deliver some keys via different byte
 * sequences). `description` is what the help dialog shows.
 */
export type KobeBinding = {
  /** Stable id used by tests / future config files. */
  id: string
  /** Chord(s) that fire this binding. First entry is the canonical label. */
  keys: readonly string[]
  /** Human-readable category for grouping in the help dialog. */
  category: "Global" | "Navigation" | "Dialog"
  /** Short description for the help dialog. */
  description: string
}

/**
 * The full kobe global keymap. Used by the help dialog to render its
 * binding table and by `useKobeKeybindings()` to know which keys to
 * register. New global bindings go here.
 *
 * NOTE: pane-local bindings (composer enter, sidebar j/k, palette
 * arrows) are NOT in this table. They register inside their own
 * components via `useBindings` directly.
 */
export const KobeKeymap: readonly KobeBinding[] = [
  {
    id: "palette.open",
    keys: ["cmd+k", "ctrl+k", "alt+k"],
    category: "Global",
    description: "Open command palette",
  },
  {
    id: "help.open",
    keys: ["f1"],
    category: "Global",
    description: "Show this help dialog",
  },
  {
    id: "focus.next",
    keys: ["tab"],
    category: "Navigation",
    description: "Focus next pane (Wave 3)",
  },
  {
    id: "focus.prev",
    keys: ["shift+tab"],
    category: "Navigation",
    description: "Focus previous pane (Wave 3)",
  },
  {
    id: "app.quit",
    keys: ["ctrl+shift+q"],
    category: "Global",
    description: "Quit (with confirm)",
  },
  {
    id: "focus.detach",
    keys: ["ctrl+q"],
    category: "Navigation",
    description: "Back to sidebar (chat keeps streaming)",
  },
  {
    id: "dialog.cancel",
    keys: ["esc"],
    category: "Dialog",
    description: "Close top dialog / cancel",
  },
] as const

/** Lookup helper used by tests and future runtime config. */
export function findBinding(id: string): KobeBinding | undefined {
  return KobeKeymap.find((b) => b.id === id)
}

/**
 * Hook arguments for `useKobeKeybindings`. Exposed so the help-dialog
 * component can pass its own opener through (the component knows how to
 * open itself via `dialog.replace(...)`; we don't reach into help-dialog
 * from this file to avoid a circular import).
 */
export type KobeKeybindingsOpts = {
  /** Open the help dialog. Required — this hook owns the `?` binding. */
  onShowHelp: () => void
  /**
   * Called when the user presses the focus-next / focus-prev keys. Wave 3
   * wires real focus management; for v1 we accept no-ops so the keys are
   * reserved and not stolen by deeper handlers.
   */
  onFocusNext?: () => void
  onFocusPrev?: () => void
  /**
   * Called after the user confirms quit. Defaults to `process.exit(0)`
   * which is correct in the production binary. Tests can pass a spy.
   */
  onQuit?: () => void
}

/**
 * Solid hook that registers kobe's global keybindings for the lifetime of
 * the component. Must be called inside a component that is itself a
 * descendant of `DialogProvider` and `CommandPaletteProvider`.
 *
 * The bindings registered here form a single group on the `useBindings`
 * stack; they coexist with dialog-internal bindings (which push their
 * own group on top, intercepting `escape` / `enter` while open).
 */
export function useKobeKeybindings(opts: KobeKeybindingsOpts): void {
  const palette: CommandPaletteContext = useCommandPalette()
  const dialog: DialogContext = useDialog()

  const onQuit = opts.onQuit ?? (() => process.exit(0))
  const onFocusNext = opts.onFocusNext ?? (() => {})
  const onFocusPrev = opts.onFocusPrev ?? (() => {})

  // Memoize the bindings list so the closure passed to useBindings is
  // stable across renders. The hook re-evaluates the config function on
  // every keypress, so closing over reactive values would still work; we
  // memoize purely to avoid garbage on hot paths.
  //
  // All chords here are modifier-prefixed (ctrl/alt) or function/named
  // keys (f1, tab, escape) so they never collide with literal typing in
  // the chat composer or any dialog input. There is no longer any
  // input-focus guard — the bindings register unconditionally.
  const bindings = createMemo(() => {
    const list: Array<{ key: string; cmd: () => void }> = [
      { key: "ctrl+k", cmd: () => palette.show() },
      { key: "alt+k", cmd: () => palette.show() },
      // `esc` universally closes the top dialog. DialogProvider owns
      // escape while a dialog is open (its handler sits higher on the
      // useBindings stack); this is the no-dialog fallback.
      {
        key: "escape",
        cmd: () => {
          if (dialog.stack.length > 0) dialog.pop()
        },
      },
      { key: "f1", cmd: () => opts.onShowHelp() },
      { key: "tab", cmd: () => onFocusNext() },
      { key: "shift+tab", cmd: () => onFocusPrev() },
      {
        key: "ctrl+shift+q",
        cmd: () => {
          if (dialog.stack.length > 0) return
          DialogConfirm.show(dialog, "Quit kobe?", "Any in-progress tasks will be detached.", "stay").then((ok) => {
            if (ok === true) onQuit()
          })
        },
      },
    ]
    return list
  })

  useBindings(() => ({ bindings: bindings() }))
}
