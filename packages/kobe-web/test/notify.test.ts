import { describe, expect, it } from "vitest"
import { shouldNotify } from "../src/lib/notify.ts"

const base = {
  prev: "running" as const,
  next: "waiting_permission" as const,
  enabled: true,
  permission: "granted" as NotificationPermission,
  hidden: true,
}

describe("shouldNotify", () => {
  it("fires on the rising edge into waiting_permission while hidden", () => {
    expect(shouldNotify(base)).toBe(true)
  })

  it("fires on the rising edge into error", () => {
    expect(shouldNotify({ ...base, next: "error" })).toBe(true)
  })

  it("does NOT fire when the page is visible", () => {
    expect(shouldNotify({ ...base, hidden: false })).toBe(false)
  })

  it("does NOT fire when disabled", () => {
    expect(shouldNotify({ ...base, enabled: false })).toBe(false)
  })

  it("does NOT fire without granted permission", () => {
    expect(shouldNotify({ ...base, permission: "default" })).toBe(false)
    expect(shouldNotify({ ...base, permission: "denied" })).toBe(false)
  })

  it("does NOT fire when already in an attention state (no rising edge)", () => {
    // waiting_permission → error is not a fresh rising edge.
    expect(shouldNotify({ ...base, prev: "waiting_permission", next: "error" })).toBe(false)
  })

  it("does NOT fire when the next state is not an attention state", () => {
    expect(shouldNotify({ ...base, next: "idle" })).toBe(false)
    expect(shouldNotify({ ...base, next: "running" })).toBe(false)
  })

  it("fires from idle/undefined into attention", () => {
    expect(shouldNotify({ ...base, prev: "idle" })).toBe(true)
    expect(shouldNotify({ ...base, prev: undefined })).toBe(true)
  })
})
