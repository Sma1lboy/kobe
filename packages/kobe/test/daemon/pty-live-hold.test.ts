import { PtyLiveHold } from "@sma1lboy/kobe-daemon/daemon/pty-live-hold"
import { describe, expect, it, vi } from "vitest"

/**
 * Unit coverage for the pty-host keep-alive cache in isolation — no socket,
 * no interval. `probeSoon()` is the same refresh the poll timer fires, so
 * driving it directly pins the transition rules: `isHeld()` mirrors the last
 * probe, and exactly the held→released edge fires `onRelease` (the
 * `reevaluateIdle` hook that lets a gui-less daemon finally idle-stop).
 */

function make(probe: () => Promise<boolean>) {
  const onRelease = vi.fn()
  const hold = new PtyLiveHold({ probe, onRelease, log: () => {} })
  return { hold, onRelease }
}

describe("PtyLiveHold", () => {
  it("starts unheld and holds once the probe sees a live session", async () => {
    const { hold, onRelease } = make(async () => true)
    expect(hold.isHeld()).toBe(false)
    await hold.probeSoon()
    expect(hold.isHeld()).toBe(true)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("fires onRelease exactly on the held→released edge", async () => {
    let live = true
    const { hold, onRelease } = make(async () => live)
    await hold.probeSoon()
    await hold.probeSoon() // true → true: no release
    live = false
    await hold.probeSoon() // true → false: release
    await hold.probeSoon() // false → false: no second release
    expect(hold.isHeld()).toBe(false)
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it("keeps the last answer when the probe throws", async () => {
    let fail = false
    const { hold, onRelease } = make(async () => {
      if (fail) throw new Error("boom")
      return true
    })
    await hold.probeSoon()
    fail = true
    await hold.probeSoon()
    expect(hold.isHeld()).toBe(true)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("dedupes overlapping probes onto one in-flight refresh", async () => {
    let resolveProbe: (value: boolean) => void = () => {}
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        }),
    )
    const { hold } = make(probe)
    const first = hold.probeSoon()
    const second = hold.probeSoon()
    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe(true)
    await Promise.all([first, second])
    expect(hold.isHeld()).toBe(true)
  })
})
