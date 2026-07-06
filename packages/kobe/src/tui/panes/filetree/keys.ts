import type { Accessor } from "solid-js"
import { useBindings } from "../../lib/keymap"
import { type FileTreeController, fileTreeBindings } from "./keys-core"

export { TAB_ORDER } from "./keys-core"
export type { FileTreeTab } from "./keys-core"

export type FileTreeBindingsOpts = FileTreeController & {
  focused: Accessor<boolean>
}

export function useFileTreeBindings(opts: FileTreeBindingsOpts): void {
  useBindings(() => ({
    enabled: opts.focused(),
    bindings: fileTreeBindings(opts),
  }))
}
