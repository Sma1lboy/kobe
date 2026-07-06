/**
 * Owner-scoped `setTimeout` book-keeping.
 *
 * Fire-and-forget `setTimeout` is the classic TUI leak: a toast
 * auto-dismiss or a deferred refocus that outlives the component that
 * scheduled it fires against a destroyed renderable (opentui can crash)
 * or mutates a signal whose provider has already unmounted.
 *
 * `createManagedTimeouts()` must be called inside a Solid owner (a
 * component body or a `createRoot`). Every timer scheduled through the
 * returned `set` is tracked, and all still-pending timers are cleared
 * when that owner is disposed — so nothing fires after unmount. `clear`
 * cancels a single timer early (and is a no-op if it already fired).
 */

import { onCleanup } from "solid-js"

export interface ManagedTimeouts {
  /** Schedule `fn` after `ms`; returns the timer id for early `clear`. */
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  /** Cancel a still-pending timer. No-op once it has fired or been cleared. */
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
