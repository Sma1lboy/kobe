import type { KeyEvent, KeyHandler } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef } from "react"
import { type BindingsConfig, type RegisteredBinding, dispatchKeyEvent } from "../../tui/lib/keymap-dispatch"

export type { Binding, BindingsConfig, RegisteredBinding } from "../../tui/lib/keymap-dispatch"
export { dispatchKeyEvent } from "../../tui/lib/keymap-dispatch"

let nextId = 1
const stack: RegisteredBinding[] = []
let installedRenderer: unknown = null
let installed: KeyHandler | null = null
let listener: ((evt: KeyEvent) => void) | null = null

function ensureInstalled(renderer: ReturnType<typeof useRenderer>): void {
  if (!renderer) {
    throw new Error("useBindings: no renderer in scope; call inside a component rendered by @opentui/react.")
  }
  if (installedRenderer === renderer) return
  if (installed && listener) installed.off("keypress", listener)
  installedRenderer = renderer
  installed = renderer.keyInput
  listener = (evt: KeyEvent) => {
    dispatchKeyEvent(stack, evt)
  }
  installed.on("keypress", listener)
}

export function useBindings(config: () => BindingsConfig): void {
  const renderer = useRenderer()
  ensureInstalled(renderer)

  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    const reg: RegisteredBinding = { config: () => configRef.current(), id: nextId++ }
    stack.push(reg)
    return () => {
      const i = stack.findIndex((r) => r.id === reg.id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [])
}
