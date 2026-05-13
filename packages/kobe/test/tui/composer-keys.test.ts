import { describe, expect, test } from "vitest"
import { isPermissionModeCycleKey } from "../../src/tui/panes/chat/composer/keys.ts"

describe("isPermissionModeCycleKey", () => {
  test("accepts CSI-u style shift+tab", () => {
    expect(isPermissionModeCycleKey({ name: "tab", shift: true })).toBe(true)
  })

  test("accepts legacy backtab", () => {
    expect(isPermissionModeCycleKey({ name: "backtab" })).toBe(true)
  })

  test("does not treat plain tab as permission mode cycling", () => {
    expect(isPermissionModeCycleKey({ name: "tab" })).toBe(false)
  })
})
