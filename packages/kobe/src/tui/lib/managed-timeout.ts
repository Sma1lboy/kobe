import { onCleanup } from "solid-js"

export interface ManagedTimeouts {
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clear(id: ReturnType<typeof setTimeout>): void
}

export function createManagedTimeouts(): ManagedTimeouts {
  const pending = new Set<ReturnType<typeof setTimeout>>()

  function set(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      pending.delete(id)
      fn()
    }, ms)
    pending.add(id)
    return id
  }

  function clear(id: ReturnType<typeof setTimeout>): void {
    if (pending.delete(id)) clearTimeout(id)
  }

  onCleanup(() => {
    for (const id of pending) clearTimeout(id)
    pending.clear()
  })

  return { set, clear }
}
