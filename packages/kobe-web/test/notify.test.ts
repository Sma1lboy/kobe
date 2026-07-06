import { describe, expect, it } from "vitest"
import { notifyGateOpen, shouldNotify } from "../src/lib/notify.ts"

const base = {
  prev: "running" as const,
  next: "waiting_permission" as const,
  enabled: true,
  permission: "granted" as NotificationPermission,
  hidden: true,
  engineEnabled: true,
}

describe("notifyGateOpen", () => {
  const gate = {
    enabled: true,
    permission: "granted" as NotificationPermission,
    hidden: true,
    categoryEnabled: true,
  }
  it("opens only when feature on + granted + hidden + category on", () => {
    expect(notifyGateOpen(gate)).toBe(true)
  })
  it("closes when the master switch is off", () => {
    expect(notifyGateOpen({ ...gate, enabled: false })).toBe(false)
  })
  it("closes without granted permission", () => {
    expect(notifyGateOpen({ ...gate, permission: "default" })).toBe(false)
  })
  it("closes when the page is visible", () => {
    expect(notifyGateOpen({ ...gate, hidden: false })).toBe(false)
  })
  it("closes when this category is disabled", () => {
    expect(notifyGateOpen({ ...gate, categoryEnabled: false })).toBe(false)
  })
})

describe("shouldNotify", () => {
  it("fires on the rising edge into waiting_permission while hidden", () => {
    expect(shouldNotify(base)).toBe(true)
  })

  it("does NOT fire when the engine category is disabled", () => {
    expect(shouldNotify({ ...base, engineEnabled: false })).toBe(false)
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
