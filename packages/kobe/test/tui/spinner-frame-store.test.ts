/**
 * Shared spinner-frame store — the Sidebar's 10Hz pulse. Pins the lifecycle
 * that makes it cheap: the interval exists only while someone subscribes, an
 * all-idle rail keeps zero timers, and unsubscribing the last row rewinds the
 * frame so a later loading row starts from a deterministic 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spinnerFrameSnapshot, spinnerTimerRunning, subscribeSpinnerFrame } from "../../src/tui/lib/spinner-frame-store"
import { SPINNER_FRAME_MS } from "../../src/tui/panes/sidebar/row-view"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("spinner frame store", () => {
  it("runs the interval only while subscribed and notifies each tick", () => {
    expect(spinnerTimerRunning()).toBe(false)

    const ticks: number[] = []
    const unsubscribe = subscribeSpinnerFrame(() => ticks.push(spinnerFrameSnapshot()))
    expect(spinnerTimerRunning()).toBe(true)

    vi.advanceTimersByTime(SPINNER_FRAME_MS * 3)
    expect(ticks).toEqual([1, 2, 3])

    unsubscribe()
    expect(spinnerTimerRunning()).toBe(false)
    expect(spinnerFrameSnapshot()).toBe(0)

    // No zombie notifications after the last unsubscribe.
    vi.advanceTimersByTime(SPINNER_FRAME_MS * 3)
    expect(ticks).toEqual([1, 2, 3])
  })

  it("keeps one shared interval across overlapping subscribers", () => {
    const a: number[] = []
    const b: number[] = []
    const offA = subscribeSpinnerFrame(() => a.push(spinnerFrameSnapshot()))
    vi.advanceTimersByTime(SPINNER_FRAME_MS)
    const offB = subscribeSpinnerFrame(() => b.push(spinnerFrameSnapshot()))
    vi.advanceTimersByTime(SPINNER_FRAME_MS)

    expect(a).toEqual([1, 2])
    expect(b).toEqual([2])

    offA()
    expect(spinnerTimerRunning()).toBe(true)
    vi.advanceTimersByTime(SPINNER_FRAME_MS)
    expect(a).toEqual([1, 2])
    expect(b).toEqual([2, 3])

    offB()
    expect(spinnerTimerRunning()).toBe(false)
  })
})
