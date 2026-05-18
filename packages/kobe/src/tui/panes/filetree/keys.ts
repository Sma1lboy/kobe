/**
 * File tree pane key bindings — Solid hook layer.
 *
 * Bindings (only when `focused()` is true):
 *   - `j` / `down`         next row
 *   - `k` / `up`           previous row
 *   - `1` / `2` / `3`      switch to All / Changes / Checks tab
 *   - `enter` / `return`   open current file (calls `onOpenFile`)
 *   - `r`                  refresh (re-run git commands)
 *
 * The bindings reach into a tiny controller object the parent
 * (`FileTree.tsx`) exposes — same shape as the sidebar's
 * `useSidebarBindings` so anyone reading the codebase recognises the
 * pattern. The controller indirection lets the FileTree component
 * avoid passing 5 separate setters into this hook.
 *
 * No multi-key chords. The brief explicitly waives vim niceties for v1
 * — adding `g g` etc. would mean lifting `controller.ts`-style chord
 * machinery from the sidebar, and it's not worth the LoC for this
 * pane until we have at least two chords that need it.
 *
 * Why a separate file: keeps `useBindings` (which transitively imports
 * `@opentui/solid` and therefore `@opentui/core`) out of the file tree
 * pane's pure-logic modules (`git.ts`). Tests that exercise parsing
 * import `git.ts` directly; tests that exercise navigation logic
 * exercise the controller from `FileTree.tsx` indirectly via the host.
 */

import type { Accessor } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"

/** Tab identifiers — kept here so `keys.ts` doesn't import from the
 * component file (which would create a circular import once `FileTree.tsx`
 * imports the hook from here). */
export type FileTreeTab = "all" | "changes"

/** Tab order for `[`/`]` cycling. Same source-order as the visible chips. */
export const TAB_ORDER: readonly FileTreeTab[] = ["all", "changes"]

export type FileTreeBindingsOpts = {
  /** Whether the pane should respond to keys. Default `() => true`. */
  focused: Accessor<boolean>
  /** Move the cursor to the next visible row. */
  moveDown: () => void
  /** Move the cursor to the previous visible row. */
  moveUp: () => void
  /** Switch to a tab (used both by mouse-clicks and the cycle handler below). */
  setTab: (tab: FileTreeTab) => void
  /** Returns the currently active tab — the cycle handler reads it to
   *  know where `[`/`]` should land relative to the current selection. */
  currentTab: Accessor<FileTreeTab>
  /** Activate the row under the cursor (calls `onOpenFile` upstream). */
  openCurrent: () => void
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
 * Register the pane's local key bindings. Tear-down happens
 * automatically via `useBindings`'s `onCleanup` hook when the host
 * component unmounts.
 */
export function useFileTreeBindings(opts: FileTreeBindingsOpts): void {
  useBindings(() => ({
    enabled: opts.focused(),
    bindings: bindByIds({
      "files.nav": (evt) => {
        if (evt.name === "j" || evt.name === "down") opts.moveDown()
        else if (evt.name === "k" || evt.name === "up") opts.moveUp()
      },
      "files.hierarchy": (evt) => {
        if (evt.name === "l" || evt.name === "right") opts.expandOrDescend()
        else if (evt.name === "h" || evt.name === "left") opts.collapseOrParent()
      },
      "files.tab": (evt) => {
        const cur = opts.currentTab()
        const idx = TAB_ORDER.indexOf(cur)
        if (idx < 0) return
        const delta = evt.name === "[" ? -1 : evt.name === "]" ? 1 : 0
        if (delta === 0) return
        const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length]
        if (next) opts.setTab(next)
      },
      "files.open": () => opts.openCurrent(),
      "files.openExternal": () => opts.openExternal(),
      "files.refresh": () => opts.refresh(),
    }),
  }))
}
