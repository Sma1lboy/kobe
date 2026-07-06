import type { KeyEvent } from "@opentui/core"

export type Binding = {
  key: string
  cmd: (event: KeyEvent, slot?: number) => void
  slot?: number
}

export type BindingsConfig = {
  enabled?: boolean
  bindings: Binding[]
}

export type RegisteredBinding = {
  config: () => BindingsConfig
  id: number
}

export function matchKey(evt: KeyEvent): string[] {
  const base: string[] = []
  const name = evt.name
  if (name) base.push(name)
  if (name === "return") base.push("enter")
  if (name === "enter") base.push("return")

  if (name === "backspace" && evt.raw === "\b" && !evt.meta && !evt.option) base.push("ctrl+h")
  if (name === "linefeed" && !evt.meta && !evt.option) base.push("ctrl+j")

  const mods: string[] = []
  if (evt.ctrl) mods.push("ctrl")
  if (evt.meta) mods.push("cmd")
  if (evt.option) mods.push("alt")
  if (evt.shift && name && name.length > 1) mods.push("shift")

  if (mods.length === 0) return base
  const prefix = `${mods.join("+")}+`
  return base.map((n) => prefix + n)
}

let dispatching = false

export function dispatchKeyEvent(
  bindingStack: readonly RegisteredBinding[],
  evt: {
    defaultPrevented: boolean
    preventDefault(): void
    name?: string
    raw?: string
    ctrl?: boolean
    meta?: boolean
    option?: boolean
    shift?: boolean
  },
): boolean {
  if (evt.defaultPrevented) return false
  if (dispatching) return false
  const snapshot = bindingStack.slice()
  const candidates = matchKey(evt as KeyEvent)
  dispatching = true
  try {
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const reg = snapshot[i]
      if (!reg) continue
      const cfg = reg.config()
      if (cfg.enabled === false) continue
      const hit = cfg.bindings.find((b) => candidates.includes(b.key))
      if (hit) {
        hit.cmd(evt as KeyEvent, hit.slot)
        evt.preventDefault()
        return true
      }
    }
    return false
  } finally {
    dispatching = false
  }
}
