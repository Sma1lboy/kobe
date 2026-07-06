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
