/**
 * React access to the kobe keymap (issue #15, G2). The data table, lookup
 * fns, and override machinery are the framework-free parts of
 * `src/tui/context/keybindings.ts` and are re-exported untouched; the only
 * React-specific piece is subscribing chord legends to live keymap reloads
 * (the table is mutated in place, invisible to React without a version
 * subscription).
 */

import { useSyncExternalStore } from "react"
import { keymapVersion, subscribeKeymapVersion } from "../../tui/context/keybindings"

export {
  KobeKeymap,
  findBinding,
  chordsOf,
  bindByIds,
  resetKeymapToDefaults,
  bumpKeymapVersion,
  subscribeKeymapVersion,
} from "../../tui/context/keybindings"
export type { KobeBinding, KobeBindingScope, KobeBindingHint } from "../../tui/context/keybindings"

/**
 * Subscribe the component to keymap reloads. Returns the current version
 * counter — use it as a dependency to recompute chord legends.
 */
export function useKeymapVersion(): number {
  // keymapVersion is a plain getter over the module-level version
  // counter, which is exactly what getSnapshot wants.
  return useSyncExternalStore(subscribeKeymapVersion, keymapVersion, keymapVersion)
}
