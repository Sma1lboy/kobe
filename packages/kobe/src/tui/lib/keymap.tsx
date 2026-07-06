import type { KeyEvent, KeyHandler } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, onCleanup } from "solid-js"
import { type BindingsConfig, type RegisteredBinding, dispatchKeyEvent } from "./keymap-dispatch"

export type { Binding, BindingsConfig, RegisteredBinding } from "./keymap-dispatch"
export { dispatchKeyEvent } from "./keymap-dispatch"

let nextId = 1
const stack: RegisteredBinding[] = []
let installedRenderer: unknown = null
let installed: KeyHandler | null = null
let listener: ((evt: KeyEvent) => void) | null = null

function ensureInstalled() {
  const renderer = useRenderer()
  if (!renderer) {
    throw new Error("useBindings: no renderer in scope; call inside a component rendered by @opentui/solid.")
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
  ensureInstalled()
  const id = nextId++
  const reg: RegisteredBinding = { config, id }

  createEffect(() => {
    void config()
  })

  stack.push(reg)
  onCleanup(() => {
    const i = stack.findIndex((r) => r.id === id)
    if (i >= 0) stack.splice(i, 1)
  })
}
