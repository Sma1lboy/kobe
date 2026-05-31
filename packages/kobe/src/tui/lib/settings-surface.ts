/**
 * Where the Settings UI shows up (KOB — settings-as-page).
 *
 * Two surfaces:
 *   - `chattab`   — a dedicated full-window `kobe settings` page, opened
 *                   as a new tmux chat-tab window alongside the engine
 *                   tabs (the default). See `openSettingsTab`.
 *   - `taskpanel` — the in-pane `SettingsDialog` overlay rendered inside
 *                   the left Tasks pane (the original v0.6 behaviour).
 *
 * The choice is a shared kv preference (state.json), toggled in the
 * Settings → General section so both surfaces stay in sync across panes.
 */

export type SettingsSurface = "chattab" | "taskpanel"

export const SETTINGS_SURFACE_KEY = "settings.surface"

export const DEFAULT_SETTINGS_SURFACE: SettingsSurface = "chattab"

/** Coerce an unknown kv value to a valid surface, defaulting to chattab. */
export function normalizeSettingsSurface(value: unknown): SettingsSurface {
  return value === "taskpanel" ? "taskpanel" : "chattab"
}
