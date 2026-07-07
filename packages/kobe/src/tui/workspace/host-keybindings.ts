/**
 * Workspace-host keybinding registration — extracted from `host.tsx`
 * (file-size cap). Owns the four `useBindings` blocks the native workspace
 * needs, plus the quit/exit and pane-cycle helpers only those bindings use.
 *
 * Pure wiring: every handler is a closure the host passes in; this module
 * adds no state of its own beyond the renderer handle `exitApp` needs. See
 * `docs/KEYBINDINGS.md` for the scope/boundary rules these rows follow.
 */

import { useRenderer } from "@opentui/solid"
import { HelpDialog } from "../component/help-dialog"
import type { FocusContextValue, PaneId } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

// Slot 3 (ctrl+l — "terminal" in the 4-pane model) maps back to workspace:
// this host is 3-pane and its middle column IS the terminal, so ctrl+l
// would otherwise be a dead key for anyone with tmux-layer muscle memory.
const PANE_BY_SLOT = ["sidebar", "workspace", "files", "workspace"] as const satisfies readonly PaneId[]
// Cycle order for focus.next — the host's real panes, NOT the context's
// PANE_ORDER: that includes "terminal", which this host never mounts, and
// cycling focus onto an unmounted pane would strand it.
const PANE_CYCLE = ["sidebar", "workspace", "files"] as const satisfies readonly PaneId[]

export type WorkspaceKeybindingDeps = {
  focus: FocusContextValue
  dialog: DialogContext
  settingsOpen: () => boolean
  worktreesOpen: () => boolean
  openWorktrees: () => void
  searchActive: () => boolean
  selectedId: () => string | null
  openSettings: () => void
  closeSettings: () => void
  createTask: () => void
  renameBranch: (id: string) => void
  cycleVendor: (id: string) => void
}

export function useWorkspaceKeybindings(deps: WorkspaceKeybindingDeps): void {
  const { focus, dialog } = deps
  const renderer = useRenderer()

  /**
   * Restore the terminal BEFORE exiting — a bare process.exit leaves mouse
   * tracking / kitty keyboard on, spraying `35;66;18M`-style junk into the
   * user's shell. destroy() also runs the render options' onDestroy
   * (orchestrator dispose). Same shape as settings-dialog/actions.ts.
   */
  function exitApp(): void {
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    process.exit(0)
  }

  async function quit(): Promise<void> {
    const ok = await DialogConfirm.show(
      dialog,
      t("workspace.quit.confirmTitle"),
      t("workspace.quit.confirmBody"),
      t("common.cancel"),
      t("workspace.quit.confirmLabel"),
    )
    if (ok) exitApp()
  }

  function cyclePane(delta: 1 | -1): void {
    const idx = PANE_CYCLE.indexOf(focus.focused() as (typeof PANE_CYCLE)[number])
    const next = (idx + delta + PANE_CYCLE.length) % PANE_CYCLE.length
    focus.setFocused(PANE_CYCLE[next] as PaneId)
  }

  const pagesClosed = () => deps.dialog.stack.length === 0 && !deps.settingsOpen() && !deps.worktreesOpen()

  useBindings(() => ({
    enabled: pagesClosed(),
    bindings: [
      ...bindByIds({
        "help.open": () => HelpDialog.show(dialog),
        "focus.numeric": (_evt, slot) => {
          const pane = PANE_BY_SLOT[slot ?? 0]
          if (pane) focus.setFocused(pane)
        },
        // f4 — reserved from terminal passthrough, so the cycle behaves
        // identically from every pane including inside the terminal.
        // Deliberately not tab/shift+tab (engine completion / plan-mode);
        // see the keymap row comment. Forward-only.
        "focus.next": () => cyclePane(1),
      }),
    ],
  }))
  useBindings(() => ({
    enabled: pagesClosed() && !focus.is("sidebar")(),
    bindings: bindByIds({
      "focus.sidebar": () => focus.setFocused("sidebar"),
    }),
  }))
  useBindings(() => ({
    enabled: pagesClosed() && focus.is("sidebar")(),
    bindings: bindByIds({
      // Slot dispatch (SLOT_CONTRACTS): slot 0 = quit confirm, slot 1 =
      // hard exit — so user rebinds keep both verbs without inspecting
      // the event's modifiers.
      "app.quit": (_evt, slot) => {
        if (slot === 1) {
          exitApp()
          return
        }
        void quit()
      },
      "settings.open.sidebar": () => deps.openSettings(),
      "worktrees.open.sidebar": () => deps.openWorktrees(),
    }),
  }))
  // Task-lifecycle chords (issue #20 — the tmux Tasks pane's n/b/v set).
  // d/a/r/pin/move fire from the Sidebar's OWN keys via the Request props;
  // these three are host-scoped in both hosts. Gated on sidebar focus + no
  // dialog + search inactive (typing `n` into the search box must not open
  // the new-task dialog — same chord-leak class).
  useBindings(() => ({
    enabled: pagesClosed() && focus.is("sidebar")() && !deps.searchActive(),
    bindings: bindByIds({
      "task.new": () => deps.createTask(),
      "tasks.renameBranch": () => {
        const id = deps.selectedId()
        if (id) deps.renameBranch(id)
      },
      "tasks.cycleEngine": () => {
        const id = deps.selectedId()
        if (id) deps.cycleVendor(id)
      },
      // Right arrow — the tmux Tasks pane's "go right into the engine"
      // gesture (tasks.focusEngine), same row, pure-TUI equivalent: focus
      // the workspace terminal. Gated on search-inactive (this group), so
      // Right while typing a query keeps moving the input cursor.
      "tasks.focusEngine": () => focus.setFocused("workspace"),
    }),
  }))
  // Page-level close keys for the settings swap — mirrors settings/host.tsx's
  // standalone page (no enclosing dialog stack to own esc/Ctrl+C, so the
  // page binds them itself; gated on an empty dialog stack so a sub-dialog,
  // e.g. the engine-command editor, keeps esc/typing for itself).
  useBindings(() => ({
    enabled: deps.settingsOpen() && deps.dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: deps.closeSettings },
      { key: "q", cmd: deps.closeSettings },
      { key: "ctrl+c", cmd: deps.closeSettings },
    ],
  }))
}
