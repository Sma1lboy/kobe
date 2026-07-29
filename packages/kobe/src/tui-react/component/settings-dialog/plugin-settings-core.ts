/**
 * Per-plugin settings: the pure half. A plugin's `[[settings]]` manifest
 * block is the SCHEMA and its config `.env` is the STORE
 * (`@sma1lboy/kobe-daemon/plugins/settings-env`); this module joins the two
 * into displayable child rows and owns the three edit rules — cycle an
 * enum, flip a boolean, validate a number. No fs, no React, so vitest can
 * pin the behaviour without a terminal.
 */

import type { PluginSetting } from "@sma1lboy/kobe-daemon/plugins/manifest"

export interface PluginSettingRowView {
  /** Env var name in the plugin's config .env. */
  readonly key: string
  /** Plugin-owned copy — rendered raw, like an action title. */
  readonly label: string
  readonly type: PluginSetting["type"]
  /** Enum choices; empty for the other types. */
  readonly options: readonly string[]
  /** The manifest's `default`, or "" when it declares none. */
  readonly defaultValue: string
  /** Stored value, falling back to `defaultValue`. */
  readonly value: string
  /** Nothing stored yet — the row renders muted. */
  readonly defaulted: boolean
}

/** Schema × stored `KEY=value` pairs → one child row per declared setting. */
export function pluginSettingRows(
  schema: readonly PluginSetting[],
  values: Record<string, string>,
): PluginSettingRowView[] {
  return schema.map((setting) => {
    const stored = values[setting.key]
    const defaultValue = setting.default ?? ""
    return {
      key: setting.key,
      label: setting.label,
      type: setting.type,
      options: setting.options ?? [],
      defaultValue,
      value: stored ?? defaultValue,
      defaulted: stored === undefined,
    }
  })
}

/**
 * A boolean is on unless it's absent or an explicit falsy token. Shells
 * source these files, so "0"/"false" are the spellings a plugin author
 * would write by hand.
 */
export function isBooleanOn(value: string): boolean {
  return value !== "" && value !== "0" && value.toLowerCase() !== "false"
}

/** Enum activation: the next option, wrapping; unknown current → the first. */
export function nextEnumValue(options: readonly string[], current: string): string {
  if (options.length === 0) return current
  const i = options.indexOf(current)
  return options[(i + 1) % options.length] as string
}

/**
 * Boolean activation. Off normally REMOVES the key (""), but a setting
 * whose manifest default is truthy would then read back as on, so that
 * one needs an explicit "0" to stay off.
 */
export function toggledBooleanValue(row: PluginSettingRowView): string {
  if (!isBooleanOn(row.value)) return "1"
  return isBooleanOn(row.defaultValue) ? "0" : ""
}

/**
 * Number input: "" clears the key, anything non-numeric is rejected
 * (`null`) so the caller can complain instead of writing junk the plugin
 * would have to defend against.
 */
export function normalizeNumberInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === "") return ""
  const n = Number(trimmed)
  return Number.isFinite(n) ? String(n) : null
}
