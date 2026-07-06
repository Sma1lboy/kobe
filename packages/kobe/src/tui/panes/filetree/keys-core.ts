/**
 * Framework-free core of the file tree pane's key bindings — the tab
 * vocabulary plus the id → controller-action map that both the Solid hook
 * (`keys.ts`) and the React pane (`src/tui-react/panes/filetree/`) register
 * through their respective `useBindings` layers. Extracted from `keys.ts`
 * (issue #15, G3) so the slot-multiplexed dispatch — the property that makes
 * these chords user-rebindable — is single-sourced across both runtimes.
 *
 * `bindByIds` itself is framework-free (the React keybindings context
 * re-exports it from the same module), so the full `Binding[]` construction
 * can live here; only the per-keypress registration is framework-specific.
 */

import { bindByIds } from "../../context/keybindings"
import type { Binding } from "../../lib/keymap-dispatch"

/** Tab identifiers — kept out of the component files so neither runtime's
 * view creates a circular import with its bindings hook. */
export type FileTreeTab = "all" | "changes"

/** Tab order for `[`/`]` cycling. Same source-order as the visible chips. */
export const TAB_ORDER: readonly FileTreeTab[] = ["all", "changes"]

/** i18n key for a tab's display label — each runtime resolves it through
 * its own reactive `t` so language switches repaint the chips. */
export function tabLabelKey(tab: FileTreeTab): string {
  switch (tab) {
    case "all":
      return "files.tabs.all"
    case "changes":
      return "files.tabs.changes"
  }
}

/**
 * The controller surface the bindings drive. Plain thunks — a Solid
 * `Accessor` satisfies `currentTab` structurally, React passes closures
 * over the latest render (its `useBindings` re-reads config per keypress).
 */
export type FileTreeController = {
  /** Move the cursor to the next visible row. */
  moveDown: () => void
  /** Move the cursor to the previous visible row. */
  moveUp: () => void
  /** Switch to a tab (used both by mouse-clicks and the cycle handler below). */
  setTab: (tab: FileTreeTab) => void
  /** Returns the currently active tab — the cycle handler reads it to
   *  know where `[`/`]` should land relative to the current selection. */
  currentTab: () => FileTreeTab
  /** Activate the row under the cursor (calls `onOpenFile` upstream). */
  openCurrent: () => void
  /** `a` — inject the current file as an `@<path>` mention (Ops host only). */
  mentionCurrent?: () => void
  /** `p` — inject the Create PR prompt into the engine pane (Ops host only). */
  createPR?: () => void
  /** Hand the current row off to the OS default app (audio, video, PDF). */
  openExternal: () => void
  /** Force a reload of the current tab's data. */
  refresh: () => void
  /** `l` — expand current dir / descend into it / open file. */
  expandOrDescend: () => void
  /** `h` — collapse current dir or jump to parent. */
  collapseOrParent: () => void
}

/**
 * Build the pane's binding table. Direction-multiplexed ids dispatch on the
 * matched chord's SLOT (its index in the id's keys array, threaded through
 * by bindByIds → dispatchKeyEvent), never on evt.name — that's what makes
 * them user-rebindable. Layouts live in SLOT_CONTRACTS
 * (lib/keymap-overrides.ts):
 *   files.nav        [down, up] pairs         (default j, k, down, up)
 *   files.hierarchy  [collapse, expand] pairs (default h, l, left, right)
 *   files.tab        [previous, next] pairs   (default [, ])
 */
export function fileTreeBindings(opts: FileTreeController): Binding[] {
  return bindByIds({
    "files.nav": (_evt, slot) => {
      if ((slot ?? 0) % 2 === 0) opts.moveDown()
      else opts.moveUp()
    },
    "files.hierarchy": (_evt, slot) => {
      if ((slot ?? 0) % 2 === 0) opts.collapseOrParent()
      else opts.expandOrDescend()
    },
    "files.tab": (_evt, slot) => {
      const cur = opts.currentTab()
      const idx = TAB_ORDER.indexOf(cur)
      if (idx < 0) return
      const delta = (slot ?? 0) % 2 === 0 ? -1 : 1
      const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length]
      if (next) opts.setTab(next)
    },
    "files.open": () => opts.openCurrent(),
    "files.mention": () => opts.mentionCurrent?.(),
    "files.createPR": () => opts.createPR?.(),
    "files.openExternal": () => opts.openExternal(),
    "files.refresh": () => opts.refresh(),
  })
}
