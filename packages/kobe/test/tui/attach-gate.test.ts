import { describe, expect, it } from "vitest"
import { ATTACH_TTL_MS, createAttachGate } from "../../src/tui/lib/attach-gate"

/**
 * The attach gate decides whether background pollers may spawn subprocesses.
 * Pin its three load-bearing behaviors: the TTL cache (one probe per window,
 * however many pollers ask), the attached/detached parse, and fail-open (a
 * probe failure must never quiesce a possibly-visible pane).
 */

function fakeProbe(results: Array<{ code: number; stdout: string } | Error>) {
  let calls = 0
  const probe = async () => {
    const r = results[Math.min(calls, results.length - 1)]
    calls++
    if (r instanceof Error) throw r
    return r as { code: number; stdout: string }
  }
  return { probe, callCount: () => calls }
}

describe("createAttachGate", () => {
  it("parses attached (>0) and detached (0) probe output", async () => {
    let t = 0
    const attached = createAttachGate(
      async () => ({ code: 0, stdout: "1\n" }),
      () => t,
    )
    await expect(attached()).resolves.toBe(true)

    t += ATTACH_TTL_MS + 1
    const detached = createAttachGate(
      async () => ({ code: 0, stdout: "0\n" }),
      () => 0,
    )
    await expect(detached()).resolves.toBe(false)
  })

  it("caches within the TTL — many callers share one probe", async () => {
    let t = 0
    const { probe, callCount } = fakeProbe([{ code: 0, stdout: "0" }])
    const gate = createAttachGate(probe, () => t)
    await gate()
    await gate()
    await gate()
    expect(callCount()).toBe(1)

    t = ATTACH_TTL_MS + 1
    await gate()
    expect(callCount()).toBe(2)
  })

  it("flips detached → attached after the TTL expires", async () => {
    let t = 0
    const { probe } = fakeProbe([
      { code: 0, stdout: "0" },
      { code: 0, stdout: "1" },
    ])
    const gate = createAttachGate(probe, () => t)
    await expect(gate()).resolves.toBe(false)
    t = ATTACH_TTL_MS + 1
    await expect(gate()).resolves.toBe(true)
  })

  it("fails open on a non-zero exit, garbage output, or a thrown probe", async () => {
    const nonZero = createAttachGate(
      async () => ({ code: 1, stdout: "" }),
      () => 0,
    )
    await expect(nonZero()).resolves.toBe(true)

    const garbage = createAttachGate(
      async () => ({ code: 0, stdout: "not-a-number" }),
      () => 0,
    )
    await expect(garbage()).resolves.toBe(true)

    const throws = createAttachGate(
      async () => {
        throw new Error("no tmux")
      },
      () => 0,
    )
    await expect(throws()).resolves.toBe(true)
  })
})
