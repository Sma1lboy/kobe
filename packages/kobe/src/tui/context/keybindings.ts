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
 *   - `hint` is cosmetic display metadata. Help uses it to print friendly
 *     pseudo-chords (`j/k`, `ctrl+hjkl`, etc.). The status bar also uses it
 *     unless `hint.status === false`. `hint.pin = "right"` keeps the hint
 *     in the always-visible right column; otherwise the hint shows only while
 *     its scope is focused. `hint == null` means no friendly display override.
 *   - `description` + `category` feed the help dialog (F1).
 *
 * Hint vs. chord:
 *   - The status bar may show a collapsed pseudo-chord (e.g. "j/k" for
 *     four real chords or "1/2/3") — that's `hint.keys`. The actually
 *     registered chords stay in `keys` and remain individually testable.
 *
 * Re-binding a chord = mutate `keys` for the relevant id. Users do this
 * via `~/.kobe/settings/keybindings.yaml`, applied once at TUI boot by
 * `applyUserKeybindings()` (context/keybindings-user.ts), which mutates
 * this table in place. No pane code has to change because pane
 * registration goes through `bindByIds` and the help dialog / status bar
 * render from the (already-overridden) rows.
 *
 * Cmd / Option / Ctrl on macOS — three different modifiers, three different
 * chord prefixes:
 *
 *   - `ctrl+X`  always works; ctrl+letter has stable C0 byte mappings that
 *     every terminal forwards to the TTY. Use this as the primary chord.
 *   - `alt+X`   is the Option key on macOS. Sends `ESC X` in legacy mode and
 *     opentui surfaces it as `evt.option = true`. Note: macOS launchers
 *     (Raycast, Karabiner, Alfred) often grab Option+digit globally before it
 *     reaches the terminal. Don't rely on alt-chords as the only path.
 *   - `cmd+X`   is the Command key on macOS. Default-config terminals
 *     (Terminal.app, iTerm2, Ghostty) handle Cmd+letter as an *application*
 *     shortcut and never forward it to the TTY — so a `cmd+X` binding is a
 *     no-op there. Terminals that *can* forward modifier keys (Kitty,
 *     iTerm2 with "Send Modifier Keys" enabled, Ghostty with `keybind`) do
 *     deliver Cmd+X as `evt.meta = true`, which our keymap layer surfaces
 *     as `cmd+X`. Register `cmd+X` alongside the primary `ctrl+X` so users
 *     on forwarding terminals get the chord they expect (and `cmd+X`
 *     doesn't get silently swallowed by the stdin reader for lack of a
 *     binding).
 *
 * The native workspace also registers `ctrl+q` while the sidebar is focused,
 * matching the tmux handover's two-stage detach shape: first ctrl+q returns to
 * Tasks, second ctrl+q exits the attached UI. Plain `q` remains the sidebar
 * quit-confirm shortcut.
 */

import type { Binding } from "../lib/keymap-dispatch.ts"
import { CHAT_BINDINGS } from "./keybindings-chat.ts"
import { FILES_BINDINGS } from "./keybindings-files.ts"
import { SIDEBAR_BINDINGS } from "./keybindings-sidebar.ts"

/** Pane scopes used to gate where a binding is active. */
export type KobeBindingScope = "global" | "sidebar" | "workspace" | "files" | "terminal"

/** Status-bar hint metadata. Optional — bindings without a hint don't show in the bar. */
export type KobeBindingHint = {
  /** Display string for the chord. May be a collapsed pseudo-chord (e.g. "j/k"). */
  keys: string
  /** Short verb/noun shown next to the chord (e.g. "nav", "delete"). */
  label: string
  /**
   * `false` keeps the friendly chord in Help while suppressing it from the
   * bottom status bar. Use for low-frequency, destructive, or state-specific
   * actions that should not crowd small terminals.
   */
  status?: false
  /**
   * `"right"` keeps the hint in the always-visible right column of the
   * status bar (global / cross-pane reminders like quit, help, new).
   * Omitted = pane-local hint, only shown when the binding's scope is
   * focused.
   */
  pin?: "right"
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
    id: "help.open",
    scope: "global",
    keys: ["f1"],
    category: "Global",
    description: "Show keybindings help",
    hint: { keys: "F1", label: "help", pin: "right" },
  },
  {
    // Sidebar-only — single letter `n`. While focused on the chat
    // composer / files / terminal, `n` is just a letter you type;
    // ctrl+q jumps back to the sidebar where `n` opens the new-task
    // dialog. Avoids the muscle-memory-vs-typing collision the old
    // global `ctrl+n` had.
    id: "task.new",
    scope: "sidebar",
    keys: ["n"],
    category: "Sidebar",
    description: "New task",
    hint: { keys: "n", label: "new" },
  },
  {
    id: "task.openEditor",
    scope: "global",
    keys: ["ctrl+o"],
    category: "Global",
    description: "Open active task worktree in editor",
  },
  {
    id: "settings.open",
    scope: "global",
    keys: ["ctrl+,"],
    category: "Global",
    description: "Open settings",
  },
  {
    // Sidebar shortcut — single letter `s` mirrors the n/q pattern
    // (plain keys when the tasks list is focused). `ctrl+,` still
    // works from anywhere as the modifier-prefixed equivalent.
    id: "settings.open.sidebar",
    scope: "sidebar",
    keys: ["s"],
    category: "Sidebar",
    description: "Open settings",
    hint: { keys: "s", label: "settings", status: false },
  },
  {
    // Sidebar-only, like `task.new` — a sidebar-launched utility page, not
    // an anywhere-reachable surface like Settings, so no `ctrl+…` global
    // companion chord. NOT `w`/`e` — `keymap-slot-parity.test.ts` documents
    // those two as a free-key example for `sidebar.nav` override testing;
    // `x` avoids clobbering that.
    id: "worktrees.open.sidebar",
    scope: "sidebar",
    keys: ["x"],
    category: "Sidebar",
    description: "Open worktrees",
    hint: { keys: "x", label: "worktrees", status: false },
  },
  {
    // Sidebar-only — single letter `q` opens the quit confirm. ctrl+q is
    // also registered here for the native workspace's tmux-like two-stage
    // detach: first ctrl+q returns focus to the sidebar, second ctrl+q exits
    // the attached native UI. Pressing q while in the composer just types q.
    id: "app.quit",
    scope: "sidebar",
    keys: ["q", "ctrl+q"],
    category: "Sidebar",
    description: "Quit (with confirm)",
    hint: { keys: "q", label: "quit", status: false },
  },
  {
    // "Back to tasks" chord. Plain `q` (sidebar scope) actually quits;
    // ctrl+q is the chord-form aliased to sidebar focus, mirroring
    // esc / ctrl+1 in effect. Scope stays "workspace" for override
    // validation, but the native workspace enables it from any
    // non-sidebar pane (files/terminal too).
    id: "focus.sidebar",
    scope: "workspace",
    keys: ["ctrl+q"],
    category: "Workspace",
    description: "Back to sidebar (tasks)",
    hint: { keys: "ctrl+q", label: "tasks" },
  },

  // ─── Navigation ───────────────────────────────────────────────────────
  {
    // `ctrl+hjkl` — vim-style direct pane focus. Reliable across
    // every terminal (ctrl+letter maps to stable C0 control bytes,
    // no CSI-u / kitty keyboard / iTerm quirks). The four chords
    // map to the four panes by ordinal:
    //   ctrl+h → 1 = sidebar (TASKS)
    //   ctrl+j → 2 = workspace
    //   ctrl+k → 3 = files
    //   ctrl+l → 4 = terminal
    // Why hjkl and not 1234? ctrl+digit needs CSI-u (which iTerm2
    // doesn't fully support — ctrl+1 falls through to a bare `1`
    // byte) and alt+digit gets eaten by macOS launchers like
    // Raycast. ctrl+letter just works. The conflict with composer
    // editing chords (ctrl+h=backspace etc.) is OK in practice
    // because the user's intent when pressing ctrl+h is "switch
    // pane," and once focus moves to sidebar the textarea has
    // already lost focus.
    id: "focus.numeric",
    scope: "global",
    keys: ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"],
    category: "Navigation",
    description: "Jump to pane (h=sidebar, j=workspace, k=files, l=terminal)",
    hint: { keys: "ctrl+hjkl", label: "focus", pin: "right", status: false },
  },
  {
    // Pane cycle — walks the workspace host's panes in order
    // (sidebar → workspace → files → wrap). `f4` ONLY, everywhere:
    // it sits in RESERVED_GLOBAL_CHORDS (panes/terminal/keys-pure.ts) so
    // it fires identically from inside the embedded terminal — F2/F3/F5
    // already carry kobe's rename/split/reset vocabulary, F4 fills the row.
    // NOT `tab` (tried 2026-07-06, cut same day): the cycle path always
    // lands on the workspace terminal, which must keep tab as shell /
    // engine completion — so tab-cycling both trapped there every lap AND
    // typed a literal \t into the engine composer on arrival. NOT
    // `shift+tab` reverse either — that's claude's plan-mode chord. One
    // key, one meaning; forward-only (tmux `prefix o` shape), prev is
    // just f4 twice.
    id: "focus.next",
    scope: "global",
    keys: ["f4"],
    category: "Navigation",
    description: "Focus next pane (sidebar → workspace → files)",
    hint: { keys: "f4", label: "next pane", status: false },
  },
  {
    // Doc-only: the chord is registered inline in Chat.tsx (gated on
    // focused + streaming + no dialog). ESC no longer "detaches" focus
    // back to the sidebar — that pulled focus out from under the user
    // mid-edit. Use `ctrl+q` (`focus.sidebar`) for the explicit detach;
    // ESC in chat is reserved for interrupting the current turn.
    id: "chat.interrupt",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Interrupt current turn (esc while streaming)",
  },
  // ─── Sidebar + Tasks pane ─────────────────────────────────────────────
  // Moved to keybindings-sidebar.ts (file-size cap) — same entries, same
  // order, same live-binding contract (`kobe tasks` consumes these via
  // `bindByIds`, following user overrides).
  ...SIDEBAR_BINDINGS,

  // ─── Workspace (tmux) + Workspace (chat) ─────────────────────────────
  // Moved to keybindings-chat.ts (file-size cap) — same entries, same order.
  ...CHAT_BINDINGS,

  // ─── Files ────────────────────────────────────────────────────────────
  // Moved to keybindings-files.ts (file-size cap) — same entries, same order.
  ...FILES_BINDINGS,

  // ─── Terminal ─────────────────────────────────────────────────────────
  {
    id: "terminal.scroll-up",
    scope: "terminal",
    keys: ["ctrl+pageup"],
    category: "Terminal",
    description: "Scroll scrollback up",
    hint: { keys: "ctrl+pgup", label: "scroll", status: false },
  },
  {
    id: "terminal.scroll-down",
    scope: "terminal",
    keys: ["ctrl+pagedown"],
    category: "Terminal",
    description: "Scroll scrollback down",
  },
  {
    id: "terminal.reset",
    scope: "terminal",
    keys: ["f5"],
    category: "Terminal",
    description: "Reset terminal — kill the current shell and respawn",
    hint: { keys: "f5", label: "reset" },
  },
  // NOTE: The terminal pane's bare-key passthrough (every alphanumeric /
  // named key forwarded to the PTY) is intentionally NOT in this table.
  // Those aren't user-configurable shortcuts — they're terminal-pane
  // behavior that has to forward whatever the user types to the shell.

  // ─── Dialog (informational) ───────────────────────────────────────────
  {
    // Dialogs (DialogProvider, DialogConfirm, etc.) own their own escape
    // binding higher on the binding stack. We list this here for the
    // help dialog only — there's no global ESC handler anymore: ESC is
    // owned by DialogProvider (when a dialog is open) and Chat.tsx (when
    // chat is focused + streaming). Idle ESC is a no-op.
    id: "dialog.cancel",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Close the top dialog (esc)",
  },
  {
    // New-task dialog sub-tab cycling. Chord is registered inside the
    // dialog's own useBindings (so it wins over the workspace
    // `chat.tab.cycle-*` bindings, which are gated off while a dialog
    // is on the stack). This entry is doc-only — help dialog and any
    // future settings UI render it from here.
    id: "dialog.newtask.tab.cycle",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Switch New Task tab (Existing / New Repo)",
    hint: { keys: "ctrl+[/]", label: "tab" },
  },
] as const

/**
 * Pristine snapshot of every row's overridable fields (`keys` + `hint`),
 * captured at module load BEFORE any `applyKeymapOverrides` mutation. The
 * live-reload path ({@link resetKeymapToDefaults}) restores from this so a
 * removed override returns to its default — additive in-place mutation
 * alone can't "un-override" a row.
 */
const KEYMAP_DEFAULTS: ReadonlyMap<string, { keys: readonly string[]; hint?: KobeBindingHint }> = new Map(
  KobeKeymap.map((b) => [b.id, { keys: [...b.keys], hint: b.hint ? { ...b.hint } : undefined }]),
)

/**
 * Restore every `KobeKeymap` row to its boot-time default chords + hint.
 * Called before re-applying the (re-read) keybindings file on a live
 * reload, so the net effect is "defaults + current overrides", never a
 * pile-up of stale overrides. Mutates in place — the same cast
 * `applyKeymapOverrides` uses, since the rows are runtime-mutable despite
 * the `readonly` types.
 */
export function resetKeymapToDefaults(): void {
  for (const row of KobeKeymap) {
    const def = KEYMAP_DEFAULTS.get(row.id)
    if (!def) continue
    const mutable = row as { keys: readonly string[]; hint?: KobeBindingHint }
    mutable.keys = [...def.keys]
    mutable.hint = def.hint ? { ...def.hint } : undefined
  }
}

/**
 * A bump-only version token: every live keymap reload increments it. The
 * chord LEGENDS (status bar, help dialog) read it so they re-render after a
 * reload — the keymap array is mutated in place, so a mutation is otherwise
 * invisible to the renderer. Behaviour doesn't need it (the dispatcher
 * re-reads chords on every keypress); this is purely the display nudge.
 *
 * React consumers subscribe via `useSyncExternalStore(subscribeKeymapVersion,
 * keymapVersion)` (src/tui-react/context/keybindings.ts) — `keymapVersion()`
 * is the getSnapshot getter, `subscribeKeymapVersion` the store subscription.
 */
let keymapVersionValue = 0
const keymapVersionListeners = new Set<() => void>()

/** Current keymap version (getSnapshot for `useSyncExternalStore`). */
export function keymapVersion(): number {
  return keymapVersionValue
}

/** Subscribe to keymap reloads. Returns the unsubscribe fn. */
export function subscribeKeymapVersion(listener: () => void): () => void {
  keymapVersionListeners.add(listener)
  return () => {
    keymapVersionListeners.delete(listener)
  }
}

/** Increment {@link keymapVersion}, forcing chord legends to re-render. */
export function bumpKeymapVersion(): void {
  keymapVersionValue += 1
  for (const listener of [...keymapVersionListeners]) listener()
}

/**
 * id → row index. Safe to build once: `KobeKeymap` rows are mutated in
 * place by overrides (`keys` / `hint` fields change) but never added,
 * removed, or replaced, so the row identities the map holds stay
 * canonical forever. This keeps `findBinding` O(1) — it runs per id per
 * registered binding group on EVERY keypress (`useBindings` configs call
 * `bindByIds` on each dispatch), where the previous linear scan cost
 * ~60 row comparisons per id (~1.4k per keypress at a realistic
 * 5-group / 23-id stack).
 */
const KEYMAP_BY_ID: ReadonlyMap<string, KobeBinding> = new Map(KobeKeymap.map((b) => [b.id, b]))

/** Lookup helper used by tests and pane registration. */
export function findBinding(id: string): KobeBinding | undefined {
  return KEYMAP_BY_ID.get(id)
}

/**
 * Resolve the chord list for a binding id. Returns an empty array if the
 * id isn't found — `bindByIds` warns but doesn't throw, so a typo doesn't
 * crash the renderer.
 */
export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

/**
 * Build a list of `Binding` (chord → handler) entries from a map of
 * `binding-id → handler`. Each id's chords from `KobeKeymap` get
 * registered against the same handler. Pane code uses this so it doesn't
 * have to know the chord strings — those live in `KobeKeymap`.
 *
 * Each entry carries `slot` = the chord's index within the id's (possibly
 * user-overridden) `keys` array, and the dispatcher passes it to the
 * handler as a second argument. Multiplexed handlers (`sidebar.nav`,
 * `files.hierarchy`, …) decide direction from the slot instead of
 * `evt.name`, which is what lets users rebind those ids: the slot LAYOUT
 * is the per-id positional contract (`SLOT_CONTRACTS` in
 * keymap-overrides.ts validates override counts against it). Because the
 * `useBindings` config closure re-runs `bindByIds` on every keypress,
 * slots are always derived from the CURRENT keymap — a live keybindings
 * reload re-slots automatically.
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
    chords.forEach((c, slot) => out.push({ key: c, cmd, slot }))
  }
  return out
}
