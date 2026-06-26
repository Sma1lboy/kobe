/**
 * Unit tests for `createManagedTimeouts` — the owner-scoped setTimeout
 * book-keeper behind the TUI lifecycle-leak fix.
 *
 * Why these matter: a fire-and-forget toast auto-dismiss or deferred
 * dialog refocus that survives its provider's unmount fires against a
 * torn-down signal / destroyed renderable. The contract these pin is:
 * a timer scheduled through `set` runs normally while its Solid owner is
 * alive, `clear` cancels it early, and disposing the owner clears every
 * still-pending timer so nothing fires post-unmount. The leak is
 * invisible to a happy-path assertion, so disposal is asserted directly.
 */

import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createManagedTimeouts } from "../../../src/tui/lib/managed-timeout"

describe("createManagedTimeouts", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("fires the callback after the delay while the owner is alive", () => {
    let fired = false
    createRoot(() => {
      const timeouts = createManagedTimeouts()
      timeouts.set(() => {
        fired = true
      }, 100)
    })
    vi.advanceTimersByTime(150)
    expect(fired).toBe(true)
  })

  test("disposing the owner clears every still-pending timer", () => {
    let fired = false
    let dispose: (() => void) | undefined
    let timeouts: ReturnType<typeof createManagedTimeouts> | undefined
    createRoot((d) => {
      dispose = d
      timeouts = createManagedTimeouts()
    })
    timeouts?.set(() => {
      fired = true
    }, 100)
    dispose?.()
    vi.advanceTimersByTime(500)
    expect(fired).toBe(false)
  })

  test("clear() cancels a single pending timer early", () => {
    let fired = false
    createRoot(() => {
      const timeouts = createManagedTimeouts()
      const id = timeouts.set(() => {
        fired = true
      }, 100)
      timeouts.clear(id)
    })
    vi.advanceTimersByTime(150)
    expect(fired).toBe(false)
  })
})
