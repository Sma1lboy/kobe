import type { KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, onCleanup } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import {
  DEFAULT_PAGE_SIZE,
  PASSTHROUGH_NAMES,
  RESERVED_GLOBAL_CHORDS,
  TRAPPED_KEYS,
  keyEventToShellBytes,
} from "./keys-pure"

export { DEFAULT_PAGE_SIZE, TRAPPED_KEYS, keyEventToShellBytes }

export type TerminalBindingsOpts = {
  focused: Accessor<boolean>
  write: (data: string) => void
  paste: (text: string) => void
  scroll: (lines: number) => void
  pageSize?: Accessor<number>
  reset: () => void
}

export function useTerminalBindings(opts: TerminalBindingsOpts): void {
  const pageSize = () => opts.pageSize?.() ?? DEFAULT_PAGE_SIZE

  const bindings: { key: string; cmd: (evt: KeyEvent) => void }[] = []

  bindings.push(
    ...bindByIds({
      "terminal.scroll-up": () => opts.scroll(-pageSize()),
      "terminal.scroll-down": () => opts.scroll(pageSize()),
      "terminal.reset": () => opts.reset(),
    }),
  )

  const reserved = new Set<string>(RESERVED_GLOBAL_CHORDS)
  const forward = (evt: KeyEvent): void => {
    const bytes = keyEventToShellBytes(evt)
    if (bytes != null) opts.write(bytes)
  }
  for (const name of PASSTHROUGH_NAMES) {
    for (const prefix of ["", "ctrl+", "alt+", "shift+", "ctrl+shift+", "alt+shift+", "ctrl+alt+"]) {
      const chord = `${prefix}${name}`
      if (reserved.has(chord)) continue
      bindings.push({ key: chord, cmd: forward })
    }
  }

  useBindings(() => ({
    enabled: opts.focused(),
    bindings,
  }))

  const renderer = useRenderer()
  const forwardUnhandled = (evt: KeyEvent) => {
    if (!opts.focused() || evt.defaultPrevented) return
    const bytes = keyEventToShellBytes(evt)
    if (bytes == null) return
    opts.write(bytes)
    evt.preventDefault()
  }
  renderer.keyInput.on("keypress", forwardUnhandled)
  const forwardPaste = (evt: { bytes: Uint8Array; defaultPrevented: boolean; preventDefault(): void }) => {
    if (!opts.focused() || evt.defaultPrevented) return
    const text = new TextDecoder().decode(evt.bytes)
    if (text.length === 0) return
    opts.paste(text)
    evt.preventDefault()
  }
  renderer.keyInput.on("paste", forwardPaste)
  onCleanup(() => {
    renderer.keyInput.off("keypress", forwardUnhandled)
    renderer.keyInput.off("paste", forwardPaste)
  })
}
