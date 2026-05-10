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
export type FileTreeTab = "all" | "changes" | "checks"

/** Map a numeric key press to its tab. */
export const TAB_FOR_KEY: Record<"1" | "2" | "3", FileTreeTab> = {
  "1": "all",
  "2": "changes",
  "3": "checks",
}

export type FileTreeBindingsOpts = {
  /** Whether the pane should respond to keys. Default `() => true`. */
  focused: Accessor<boolean>
  /** Move the cursor to the next visible row. */
  moveDown: () => void
  /** Move the cursor to the previous visible row. */
  moveUp: () => void
  /** Switch to a tab. */
  setTab: (tab: FileTreeTab) => void
  /** Activate the row under the cursor (calls `onOpenFile` upstream). */
  openCurrent: () => void
  /** Force a reload of the current tab's data. */
  refresh: () => void
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
      "files.tab": (evt) => {
        switch (evt.name) {
          case "1":
            opts.setTab("all")
            break
          case "2":
            opts.setTab("changes")
            break
          case "3":
            opts.setTab("checks")
            break
        }
      },
      "files.open": () => opts.openCurrent(),
      "files.refresh": () => opts.refresh(),
    }),
  }))
}
