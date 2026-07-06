/**
 * File tree pane key bindings — Solid hook layer.
 *
 * Bindings (only when `focused()` is true):
 *   - `j` / `down`         next row
 *   - `k` / `up`           previous row
 *   - `[` / `]`            cycle All / Changes tab
 *   - `h` / `l`            collapse / expand hierarchy
 *   - `enter` / `return`   open current file in nvim/vim — `-d` diff vs HEAD
 *                          when changed, plain edit otherwise; falls back to
 *                          our opentui read-only preview (calls `onOpenFile`)
 *   - `a`                  inject current file as `@<path>` (calls `onMention`)
 *   - `p`                  create PR prompt (Ops host only)
 *   - `r`                  refresh (re-run git commands)
 *
 * The id → action map itself is the framework-free `keys-core.ts`
 * (shared with the React port); this file owns only the Solid
 * registration via `useBindings` — which transitively imports
 * `@opentui/solid`, hence the split. Tear-down happens automatically via
 * `useBindings`'s `onCleanup` hook when the host component unmounts.
 *
 * No multi-key chords. The brief explicitly waives vim niceties for v1
 * — adding `g g` etc. would mean lifting `controller.ts`-style chord
 * machinery from the sidebar, and it's not worth the LoC for this
 * pane until we have at least two chords that need it.
 */

import type { Accessor } from "solid-js"
import { useBindings } from "../../lib/keymap"
import { type FileTreeController, fileTreeBindings } from "./keys-core"

export { TAB_ORDER } from "./keys-core"
export type { FileTreeTab } from "./keys-core"

export type FileTreeBindingsOpts = FileTreeController & {
  /** Whether the pane should respond to keys. Default `() => true`. */
  focused: Accessor<boolean>
}

/** Register the pane's local key bindings. */
export function useFileTreeBindings(opts: FileTreeBindingsOpts): void {
  useBindings(() => ({
    enabled: opts.focused(),
    bindings: fileTreeBindings(opts),
  }))
}
