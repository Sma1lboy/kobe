/**
 * Central keybinding registry for kobe.
 *
 * Single source of truth for: which chords trigger which action, what the
 * help dialog displays, and what the status bar hints. Panes register
 * handlers by binding **id** (`bindByIds`) — they don't hardcode chord
 * strings. The status bar reads `KobeKeymap` directly. A future settings
 * UI can edit `KobeKeymap` (in-memory or persisted via KV) without any
 * pane having to know.
 *
 * Hand-off contract:
 *   - `id` is stable. Tests + settings persistence key off it.
 *   - `keys` is the list of chords that register the action. The first
 *     entry is the canonical chord (help dialog primary; status-bar hint
 *     when no `hint.keys` override). Multiple chords are common when a
 *     terminal delivers the same logical key as different byte sequences
 *     (`ctrl+k`/`alt+k`) or when several keys do the same thing
 *     (`j`/`down`).
 *   - `scope` says whether the binding is registered globally or only
 *     when a specific pane is focused. The pane that owns the scope
 *     calls `bindByIds(...)` with the same id → the chord(s) come from
 *     this table.
 *   - `hint` is purely cosmetic: how the status bar should label the
 *     chord. `hint.pin = "right"` keeps it in the always-visible right
 *     column; otherwise the hint shows only while its scope is focused.
 *     `hint == null` means the binding doesn't appear in the status bar.
 *   - `description` + `category` feed the help dialog (F1).
 *
 * Hint vs. chord:
 *   - The status bar may show a collapsed pseudo-chord (e.g. "j/k" for
 *     four real chords or "1/2/3") — that's `hint.keys`. The actually
 *     registered chords stay in `keys` and remain individually testable.
 *
 * Re-binding a chord = mutate `keys` for the relevant id (today: edit
 * this file; later: a settings dialog writing into a runtime overlay).
 * No pane code has to change because pane registration goes through
 * `bindByIds`.
 *
 * Cmd vs Ctrl on macOS: terminals don't propagate the Command key to the
 * PTY. We register both `ctrl+k` and `alt+k` so the same logical chord
 * works across configurations (Option+K on macOS sends `ESC k` which our
 * keymap layer surfaces as `alt+k`).
 *
 * Why `app.quit.keys` lists both `ctrl+shift+q` and `ctrl+q`: the keymap
 * layer (`src/tui/lib/keymap.tsx`) intentionally drops the shift modifier
 * on letter keys (terminals deliver shift+letter as uppercase, not as a
 * modifier event), so `ctrl+shift+q` and `ctrl+q` produce the same
 * candidate at match time. Listing both documents intent — the status-bar
 * hint advertises ctrl+shift+q (safer/harder to fat-finger) but the
 * actual byte path is ctrl+q.
 */

import { useRenderer } from "@opentui/solid"
import { type Accessor, createMemo, createSignal } from "solid-js"
import { type Binding, useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { type CommandPaletteContext, useCommandPalette } from "./command-palette"

/** Pane scopes used to gate where a binding is active. */
export type KobeBindingScope = "global" | "sidebar" | "workspace" | "files" | "terminal"

/** Status-bar hint metadata. Optional — bindings without a hint don't show in the bar. */
export type KobeBindingHint = {
  /** Display string for the chord. May be a collapsed pseudo-chord (e.g. "j/k"). */
  keys: string
  /** Short verb/noun shown next to the chord (e.g. "nav", "delete"). */
  label: string
  /**
   * `"right"` keeps the hint in the always-visible right column of the
   * status bar (global / cross-pane reminders like quit, help, new).
   * Omitted = pane-local hint, only shown when the binding's scope is
   * focused.
   */
  pin?: "right"
}

/**
 * Ctrl+C double-tap quit machinery (lifted from origin/main during the
 * keybinding-registry merge). The first Ctrl+C arms the quit; a second
 * within `CTRL_C_QUIT_WINDOW_MS` exits. Module-level state because the
 * binding is global and the StatusBar reads `useCtrlCArmed()` to render
 * the transient "Press Ctrl+C again to exit" warning chip.
 *
 * The chord itself is registered through `KobeKeymap.app.ctrl-c` →
 * `bindByIds(...)` like every other binding; only the handler body
 * (selection-aware copy / arm-then-quit state machine) lives here.
 */
const CTRL_C_QUIT_WINDOW_MS = 1500
const [ctrlCArmed, setCtrlCArmed] = createSignal(false)
let ctrlCArmTimer: ReturnType<typeof setTimeout> | null = null

/** Read the "Ctrl+C is armed for quit" flag. Reactive accessor. */
export function useCtrlCArmed(): Accessor<boolean> {
  return ctrlCArmed
}

function disarmCtrlC(): void {
  if (ctrlCArmTimer !== null) {
    clearTimeout(ctrlCArmTimer)
    ctrlCArmTimer = null
  }
  setCtrlCArmed(false)
}

/** A single binding row. */
export type KobeBinding = {
  /** Stable identifier (tests + future settings persistence key off this). */
  id: string
  /** Where the binding is registered. */
  scope: KobeBindingScope
  /**
   * Chord(s) that fire this binding. First is canonical. Multiple chords
   * exist for terminal-byte-sequence variants and equivalent keys.
   * An empty array means "this row exists for documentation/hint purposes
   * only — no chord is registered here." (Used for composer-internal keys
   * that the textarea handles via `onKeyDown`, e.g. `chat.send`.)
   */
  keys: readonly string[]
  /** Help-dialog category (groups rows visually). */
  category: string
  /** Help-dialog description text. */
  description: string
  /** Status-bar hint config. Omitted = not shown in status bar. */
  hint?: KobeBindingHint
}

/**
 * The full kobe keymap. Edit this table to rebind / rename / regroup.
 * Pane code reaches in via `chordsOf(id)` / `bindByIds({...})`; the help
 * dialog and status bar both render from this list.
 *
 * Order matters for help-dialog grouping (preserved within a category)
 * and for status-bar hint display order (left column left-to-right).
 */
export const KobeKeymap: readonly KobeBinding[] = [
  // ─── Global ───────────────────────────────────────────────────────────
  {
    id: "palette.open",
    scope: "global",
    keys: ["cmd+k", "ctrl+k", "alt+k"],
    category: "Global",
    description: "Open command palette",
  },
  {
    id: "help.open",
    scope: "global",
    keys: ["f1"],
    category: "Global",
    description: "Show this help dialog",
    hint: { keys: "F1", label: "help", pin: "right" },
  },
  {
    id: "task.new",
    scope: "global",
    keys: ["ctrl+n"],
    category: "Global",
    description: "New task",
    hint: { keys: "ctrl+n", label: "new", pin: "right" },
  },
  {
    id: "settings.open",
    scope: "global",
    keys: ["ctrl+,"],
    category: "Global",
    description: "Open settings",
  },
  {
    id: "app.quit",
    scope: "global",
    keys: ["ctrl+shift+q", "ctrl+q"],
    category: "Global",
    description: "Quit (with confirm)",
    hint: { keys: "ctrl+shift+q", label: "quit", pin: "right" },
  },

  // ─── Navigation ───────────────────────────────────────────────────────
  {
    id: "focus.next",
    scope: "global",
    keys: ["tab"],
    category: "Navigation",
    description: "Focus next pane (Wave 3)",
    hint: { keys: "tab", label: "cycle", pin: "right" },
  },
  {
    id: "focus.prev",
    scope: "global",
    keys: ["shift+tab"],
    category: "Navigation",
    description: "Focus previous pane",
  },
  {
    id: "focus.numeric",
    scope: "global",
    keys: ["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4"],
    category: "Navigation",
    description: "Jump to pane (1=sidebar, 2=workspace, 3=files, 4=terminal)",
    hint: { keys: "ctrl+1234", label: "focus", pin: "right" },
  },
  {
    id: "app.copy_or_quit",
    scope: "global",
    keys: ["ctrl+c"],
    category: "Global",
    description: "Copy selection / press twice within 1.5s to quit",
    // No hint — when ctrl+c is armed, the StatusBar swaps in a warning
    // chip in place of the regular `app.quit` hint via `useCtrlCArmed()`.
  },
  {
    id: "focus.detach",
    scope: "global",
    keys: ["esc"],
    category: "Navigation",
    description: "Back to sidebar (chat keeps streaming). Closes top dialog if any.",
    hint: { keys: "esc", label: "back to sidebar" },
  },
  {
    id: "pane.resize-grow",
    scope: "global",
    // ctrl+= / ctrl++ both register because shift+= produces `+` on most
    // layouts and the keymap normalizer drops shift on single-char names.
    keys: ["ctrl+=", "ctrl++"],
    category: "Navigation",
    description: "Grow the focused pane",
  },
  {
    id: "pane.resize-shrink",
    scope: "global",
    keys: ["ctrl+-", "ctrl+_"],
    category: "Navigation",
    description: "Shrink the focused pane",
  },

  // ─── Sidebar ──────────────────────────────────────────────────────────
  {
    id: "sidebar.nav",
    scope: "sidebar",
    keys: ["j", "k", "down", "up"],
    category: "Sidebar",
    description: "Move cursor up/down",
    hint: { keys: "j/k", label: "nav" },
  },
  {
    id: "sidebar.select",
    scope: "sidebar",
    keys: ["return"],
    category: "Sidebar",
    description: "Open the selected task",
    hint: { keys: "enter", label: "select" },
  },
  {
    id: "sidebar.goto",
    scope: "sidebar",
    keys: ["g"],
    category: "Sidebar",
    description: "Top / bottom of list (gg or shift-G)",
  },
  {
    id: "sidebar.rename",
    scope: "sidebar",
    keys: ["r"],
    category: "Sidebar",
    description: "Rename task",
    hint: { keys: "r", label: "rename" },
  },
  {
    id: "sidebar.archive",
    scope: "sidebar",
    keys: ["a"],
    category: "Sidebar",
    description: "Toggle archive",
    hint: { keys: "a", label: "archive" },
  },
  {
    id: "sidebar.view",
    scope: "sidebar",
    keys: ["[", "]"],
    category: "Sidebar",
    description: "Switch view (Working session ↔ Archives)",
    hint: { keys: "[/]", label: "view" },
  },
  {
    id: "sidebar.delete",
    scope: "sidebar",
    keys: ["d"],
    category: "Sidebar",
    description: "Delete task (with confirm)",
    hint: { keys: "d", label: "delete" },
  },

  // ─── Workspace (chat) ─────────────────────────────────────────────────
  {
    // Composer textarea handles enter via its own onKeyDown. This row
    // exists only for help-dialog + status-bar visibility; no chord is
    // registered here.
    id: "chat.send",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Send message (composer)",
    hint: { keys: "enter", label: "send" },
  },
  {
    // Composer textarea inserts a literal newline on shift+enter (kitty/
    // CSI-u terminals) and ctrl+J everywhere else; no chord is registered
    // here. Surfaced in the status bar so the user doesn't have to memorize
    // it after we stripped the inline footer hint from the composer.
    id: "chat.newline",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Newline in composer",
    hint: { keys: "shift+enter", label: "newline" },
  },
  {
    // Shift+tab inside the composer cycles the per-task permission mode
    // (default → accept edits → plan → …); the chord is registered in
    // Composer's onKeyDown, not here. Doc-only entry so the status bar
    // advertises the binding to a focused user.
    id: "chat.cycle-mode",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Cycle permission mode (composer)",
    hint: { keys: "shift+tab", label: "mode" },
  },
  {
    // Ctrl+enter mid-stream interrupts the in-flight subprocess and
    // dispatches the new buffer immediately. Plain enter while
    // streaming queues instead. Chord is registered in Composer's
    // onKeyDown; this entry is doc-only.
    id: "chat.steer",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Steer (interrupt + send) — mid-stream only",
    hint: { keys: "ctrl+enter", label: "steer" },
  },
  {
    id: "chat.tab.new",
    scope: "workspace",
    keys: ["ctrl+t"],
    category: "Workspace",
    description: "New chat tab",
  },
  {
    id: "chat.tab.close",
    scope: "workspace",
    keys: ["ctrl+w"],
    category: "Workspace",
    description: "Close chat tab",
  },
  {
    id: "chat.tab.cycle-next",
    scope: "workspace",
    keys: ["ctrl+tab"],
    category: "Workspace",
    description: "Next chat tab",
  },
  {
    id: "chat.tab.cycle-prev",
    scope: "workspace",
    keys: ["ctrl+shift+tab"],
    category: "Workspace",
    description: "Previous chat tab",
  },
  {
    id: "chat.tab.pick",
    scope: "workspace",
    keys: ["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9"],
    category: "Workspace",
    description: "Pick chat tab N (when >1 tab open; shadows focus.numeric)",
  },

  // ─── Files ────────────────────────────────────────────────────────────
  {
    id: "files.nav",
    scope: "files",
    keys: ["j", "k", "down", "up"],
    category: "Files",
    description: "Move cursor up/down",
    hint: { keys: "j/k", label: "nav" },
  },
  {
    id: "files.open",
    scope: "files",
    keys: ["return"],
    category: "Files",
    description: "Open file",
    hint: { keys: "enter", label: "open" },
  },
  {
    id: "files.tab",
    scope: "files",
    keys: ["1", "2", "3"],
    category: "Files",
    description: "Switch tab (All / Changes / Checks)",
    hint: { keys: "1/2/3", label: "tab" },
  },
  {
    id: "files.refresh",
    scope: "files",
    keys: ["r"],
    category: "Files",
    description: "Refresh",
    hint: { keys: "r", label: "refresh" },
  },

  // ─── Terminal ─────────────────────────────────────────────────────────
  {
    id: "terminal.scroll-up",
    scope: "terminal",
    keys: ["ctrl+pageup"],
    category: "Terminal",
    description: "Scroll scrollback up",
    hint: { keys: "ctrl+pgup", label: "scroll" },
  },
  {
    id: "terminal.scroll-down",
    scope: "terminal",
    keys: ["ctrl+pagedown"],
    category: "Terminal",
    description: "Scroll scrollback down",
  },
  // NOTE: The terminal pane's bare-key passthrough (every alphanumeric /
  // named key forwarded to the PTY) is intentionally NOT in this table.
  // Those aren't user-configurable shortcuts — they're terminal-pane
  // behavior that has to forward whatever the user types to the shell.

  // ─── Dialog (informational) ───────────────────────────────────────────
  {
    // Dialogs (DialogProvider, DialogConfirm, etc.) own their own escape
    // binding higher on the binding stack. We list this here for the
    // help dialog only. The actual handler in `useKobeKeybindings` does
    // double duty: pop top dialog if any, otherwise focus.detach.
    id: "dialog.cancel",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Close the top dialog (esc)",
  },
] as const

/** Lookup helper used by tests and pane registration. */
export function findBinding(id: string): KobeBinding | undefined {
  return KobeKeymap.find((b) => b.id === id)
}

/**
 * Resolve the chord list for a binding id. Returns an empty array if the
 * id isn't found — `bindByIds` warns but doesn't throw, so a typo doesn't
 * crash the renderer.
 */
export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

/** All bindings whose `scope` matches (used by status-bar left column). */
export function bindingsForScope(scope: KobeBindingScope): KobeBinding[] {
  return KobeKeymap.filter((b) => b.scope === scope)
}

/**
 * Build a list of `Binding` (chord → handler) entries from a map of
 * `binding-id → handler`. Each id's chords from `KobeKeymap` get
 * registered against the same handler. Pane code uses this so it doesn't
 * have to know the chord strings — those live in `KobeKeymap`.
 *
 * Unknown ids log a warning and are skipped (typos shouldn't crash the
 * UI, but they should be loud in dev).
 */
export function bindByIds(handlers: Record<string, Binding["cmd"]>): Binding[] {
  const out: Binding[] = []
  for (const id in handlers) {
    const cmd = handlers[id]
    if (!cmd) continue
    const chords = chordsOf(id)
    if (chords.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[kobe/keybindings] bindByIds: id="${id}" has no chords (or doesn't exist in KobeKeymap)`)
      continue
    }
    for (const c of chords) out.push({ key: c, cmd })
  }
  return out
}

// ─── Global hook ──────────────────────────────────────────────────────────

/**
 * Hook arguments for `useKobeKeybindings`. The opts inject pane-level
 * actions the global hook can trigger (e.g. opening the help dialog,
 * detaching focus back to the sidebar). All callbacks are optional so
 * tests can pass a partial set.
 */
export type KobeKeybindingsOpts = {
  /** Open the help dialog. Required — this hook owns the F1 binding. */
  onShowHelp: () => void
  /**
   * Called when the user presses focus-next / focus-prev. Wave 3 wires
   * real focus management; for v1 we accept no-ops so the keys are
   * reserved and not stolen by deeper handlers.
   */
  onFocusNext?: () => void
  onFocusPrev?: () => void
  /**
   * Called after the user confirms quit. Defaults to `process.exit(0)`
   * which is correct in the production binary. Tests can pass a spy.
   */
  onQuit?: () => void
  /**
   * Called when the user presses esc with no dialog open — "detach back
   * to sidebar". Wired by app.tsx to `setFocusedPane("sidebar")`. No-op
   * default keeps the binding harmless when the focus model isn't wired.
   */
  onFocusDetach?: () => void
}

/**
 * Solid hook that registers kobe's global keybindings for the lifetime
 * of the calling component. Must be called inside a descendant of
 * `DialogProvider` and `CommandPaletteProvider`.
 *
 * All chord strings come from `KobeKeymap` via `bindByIds` — no chord
 * is hardcoded here. The escape key is a special case (one chord, two
 * actions: pop dialog or detach), so it's registered inline rather than
 * via the table.
 */
export function useKobeKeybindings(opts: KobeKeybindingsOpts): void {
  const palette: CommandPaletteContext = useCommandPalette()
  const dialog: DialogContext = useDialog()
  const renderer = useRenderer()

  // process.exit() bypasses every opentui exit hook (`beforeExit`, signal
  // listeners), so without first calling renderer.destroy() the terminal
  // is left in TUI state on the way out: mouse tracking stays on (the
  // shell sees a stream of \x1b[<...M sequences from every mouse move),
  // alt-screen isn't restored, raw mode lingers. Tearing down the
  // renderer first writes the disable sequences synchronously to stdout
  // before exit() blocks Node.
  const onQuit =
    opts.onQuit ??
    (() => {
      // Defense in depth: if destroy() throws (FFI to native renderer
      // can fail in odd states), the user who pressed Ctrl+C×2 must
      // still get out — surface to stderr for the next shell prompt to
      // see, then force-exit unconditionally.
      try {
        renderer?.destroy()
      } catch (err) {
        console.error("kobe: renderer.destroy() failed during quit:", err)
      }
      process.exit(0)
    })
  const onFocusNext = opts.onFocusNext ?? (() => {})
  const onFocusPrev = opts.onFocusPrev ?? (() => {})
  const onFocusDetach = opts.onFocusDetach ?? (() => {})

  // Ctrl+C: three modes, in order of precedence.
  //   1. Renderer has a text selection → copy via OSC52, clear selection,
  //      and disarm any pending quit. Treats the press as "user wanted to
  //      copy, not quit", same as a terminal would.
  //   2. Already armed (previous Ctrl+C within CTRL_C_QUIT_WINDOW_MS) →
  //      quit. Always quits even if a dialog is open — Ctrl+C twice is
  //      the user explicitly demanding out, and the `q` confirm flow is
  //      a different ergonomic contract.
  //   3. Not armed → arm, schedule auto-disarm. UI surfaces (StatusBar)
  //      read `useCtrlCArmed()` to show a transient hint chip.
  function handleCtrlC(): void {
    const sel = renderer?.getSelection()
    const text = sel?.getSelectedText()
    if (text && text.length > 0) {
      renderer?.copyToClipboardOSC52(text)
      renderer?.clearSelection()
      disarmCtrlC()
      return
    }
    if (ctrlCArmed()) {
      disarmCtrlC()
      onQuit()
      return
    }
    setCtrlCArmed(true)
    if (ctrlCArmTimer !== null) clearTimeout(ctrlCArmTimer)
    ctrlCArmTimer = setTimeout(() => {
      ctrlCArmTimer = null
      setCtrlCArmed(false)
    }, CTRL_C_QUIT_WINDOW_MS)
  }

  // Memoize so the closure passed to useBindings is stable across renders.
  // The hook re-evaluates on every keypress, so closing over reactive
  // signals would still work; we memoize purely to avoid garbage on hot
  // paths.
  const bindings = createMemo<Binding[]>(() => {
    return [
      ...bindByIds({
        "palette.open": () => palette.show(),
        "help.open": () => opts.onShowHelp(),
        "focus.next": () => onFocusNext(),
        "focus.prev": () => onFocusPrev(),
        "app.quit": () => {
          if (dialog.stack.length > 0) return
          DialogConfirm.show(dialog, "Quit kobe?", "Any in-progress tasks will be detached.", "stay").then((ok) => {
            if (ok === true) onQuit()
          })
        },
        // Ctrl+C is modifier-prefixed so it never collides with composer
        // typing. DialogProvider's own ctrl+c binding sits higher on the
        // stack and still wins while a dialog is open — that's the
        // existing "ctrl+c closes dialog" behavior, unchanged.
        "app.copy_or_quit": () => handleCtrlC(),
      }),
      // esc has two responsibilities (close top dialog OR detach focus).
      // It's not a clean id→handler row, so it's registered inline.
      // DialogProvider owns escape while a dialog is open via a higher-
      // priority binding group, so the dialog.pop branch is a fallback;
      // with no dialog open we fall through to onFocusDetach.
      {
        key: "escape",
        cmd: () => {
          if (dialog.stack.length > 0) {
            dialog.pop()
          } else {
            onFocusDetach()
          }
        },
      },
    ]
  })

  useBindings(() => ({ bindings: bindings() }))
}
