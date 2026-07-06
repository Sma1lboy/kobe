export type SettingsSurface = "chattab" | "taskpanel"

export const SETTINGS_SURFACE_KEY = "settings.surface"

export const DEFAULT_SETTINGS_SURFACE: SettingsSurface = "chattab"

export function normalizeSettingsSurface(value: unknown): SettingsSurface {
  return value === "taskpanel" ? "taskpanel" : "chattab"
}
