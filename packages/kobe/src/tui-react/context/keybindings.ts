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

export function useKeymapVersion(): number {
  return useSyncExternalStore(subscribeKeymapVersion, keymapVersion, keymapVersion)
}
