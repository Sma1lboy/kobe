/**
 * Per-plugin settings view model (settings-dialog/plugin-settings-core.ts).
 *
 * These are the rules a wrong edit writes straight into a plugin's config
 * .env: which value a row shows when nothing is stored, what enter does to
 * an enum/boolean, and what counts as a number. The boolean case is the
 * subtle one — "off" normally REMOVES the key, which would silently read
 * back as on for a setting whose manifest default is truthy.
 */

import type { PluginSetting } from "@sma1lboy/kobe-daemon/plugins/manifest"
import { describe, expect, it } from "vitest"
import {
  type PluginSettingRowView,
  isBooleanOn,
  nextEnumValue,
  normalizeNumberInput,
  pluginSettingRows,
  toggledBooleanValue,
} from "../../src/tui-react/component/settings-dialog/plugin-settings-core.ts"

const SOUND: PluginSetting = {
  key: "KOBE_NOTIFY_SOUND",
  label: "Sound",
  type: "enum",
  options: ["ping", "glass"],
  default: "ping",
}
const QUIET: PluginSetting = { key: "KOBE_NOTIFY_QUIET", label: "Quiet hours", type: "boolean" }
const TITLE: PluginSetting = { key: "KOBE_NOTIFY_TITLE", label: "Title", type: "string" }
const DELAY: PluginSetting = { key: "KOBE_NOTIFY_DELAY", label: "Delay (ms)", type: "number", default: "500" }
const SCHEMA: readonly PluginSetting[] = [SOUND, QUIET, TITLE, DELAY]

const rowFor = (setting: PluginSetting, values: Record<string, string> = {}): PluginSettingRowView =>
  pluginSettingRows([setting], values)[0] as PluginSettingRowView

describe("pluginSettingRows", () => {
  it("shows the stored value, and falls back to the manifest default as defaulted", () => {
    const rows = pluginSettingRows(SCHEMA, { KOBE_NOTIFY_SOUND: "glass" })
    expect(rows.map((r) => [r.key, r.value, r.defaulted])).toEqual([
      ["KOBE_NOTIFY_SOUND", "glass", false],
      ["KOBE_NOTIFY_QUIET", "", true],
      ["KOBE_NOTIFY_TITLE", "", true],
      ["KOBE_NOTIFY_DELAY", "500", true],
    ])
  })

  it("treats a stored empty string as set, not defaulted", () => {
    expect(rowFor(DELAY, { KOBE_NOTIFY_DELAY: "" })).toMatchObject({ value: "", defaulted: false, defaultValue: "500" })
  })

  it("carries the enum options through and leaves them empty for other types", () => {
    const rows = pluginSettingRows(SCHEMA, {})
    expect(rows[0]?.options).toEqual(["ping", "glass"])
    expect(rows[1]?.options).toEqual([])
  })

  it("renders nothing for a plugin that declares no settings", () => {
    expect(pluginSettingRows([], { STRAY: "1" })).toEqual([])
  })
})

describe("nextEnumValue", () => {
  it("wraps through the options", () => {
    expect(nextEnumValue(["a", "b", "c"], "b")).toBe("c")
    expect(nextEnumValue(["a", "b", "c"], "c")).toBe("a")
  })

  it("starts at the first option when the stored value is off-list", () => {
    expect(nextEnumValue(["a", "b"], "gone")).toBe("a")
  })

  it("is a no-op with no options to cycle", () => {
    expect(nextEnumValue([], "x")).toBe("x")
  })
})

describe("boolean settings", () => {
  it("reads absent and explicit falsy tokens as off", () => {
    expect(isBooleanOn("")).toBe(false)
    expect(isBooleanOn("0")).toBe(false)
    expect(isBooleanOn("false")).toBe(false)
    expect(isBooleanOn("1")).toBe(true)
    expect(isBooleanOn("yes")).toBe(true)
  })

  it("turning off removes the key when the default is not truthy", () => {
    expect(toggledBooleanValue(rowFor(QUIET, { KOBE_NOTIFY_QUIET: "1" }))).toBe("")
  })

  it("turning off writes an explicit 0 when the default would flip it back on", () => {
    const optOut: PluginSetting = { key: "K", label: "K", type: "boolean", default: "1" }
    const row = rowFor(optOut)
    expect(row.value).toBe("1")
    expect(toggledBooleanValue(row)).toBe("0")
  })

  it("turning on always writes 1", () => {
    expect(toggledBooleanValue(rowFor(QUIET))).toBe("1")
  })
})

describe("normalizeNumberInput", () => {
  it("accepts integers, decimals, and negatives", () => {
    expect(normalizeNumberInput(" 42 ")).toBe("42")
    expect(normalizeNumberInput("1.50")).toBe("1.5")
    expect(normalizeNumberInput("-3")).toBe("-3")
  })

  it("treats empty input as a clear", () => {
    expect(normalizeNumberInput("   ")).toBe("")
  })

  it("rejects anything else", () => {
    expect(normalizeNumberInput("500ms")).toBeNull()
    expect(normalizeNumberInput("NaN")).toBeNull()
    expect(normalizeNumberInput("Infinity")).toBeNull()
  })
})
