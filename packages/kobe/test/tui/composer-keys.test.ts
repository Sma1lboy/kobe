import { describe, expect, test } from "vitest"
import { isPermissionModeCycleKey, isPlainAutocompleteTabKey } from "../../src/tui/panes/chat/composer/keys.ts"

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

describe("isPlainAutocompleteTabKey", () => {
  test("accepts named plain tab", () => {
    expect(isPlainAutocompleteTabKey({ name: "tab" })).toBe(true)
  })

  test("accepts raw tab sequence when the terminal parser omits the name", () => {
    expect(isPlainAutocompleteTabKey({ sequence: "\t" })).toBe(true)
  })

  test("rejects modified tab chords", () => {
    expect(isPlainAutocompleteTabKey({ name: "tab", shift: true })).toBe(false)
    expect(isPlainAutocompleteTabKey({ name: "tab", ctrl: true })).toBe(false)
  })
})
