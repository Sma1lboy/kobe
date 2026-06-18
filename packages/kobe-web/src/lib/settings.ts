import { api } from "./api-client.ts"

export type FocusAccent = "primary" | "success" | "info"
export type SettingsSurface = "chattab" | "taskpanel"
export type EditorKind = "auto" | "vim" | "nvim" | "nano" | "emacs" | "custom"

export interface WebSettingsEngine {
  id: string
  label: string
  command: string
  isBuiltin: boolean
  isCustom: boolean
  isDefault: boolean
}

export interface WebSettings {
  activeTheme: string
  transparentBackground: boolean
  focusAccent: FocusAccent
  notificationsToast: boolean
  notificationsSound: boolean
  settingsSurface: SettingsSurface
  editorKind: EditorKind
  editorCustomCommand: string
  remoteProjects: boolean
  autoStatus: boolean
  dispatcher: boolean
  defaultEngine: string
  engines: WebSettingsEngine[]
}

export type WebSettingsPatch = Partial<
  Pick<
    WebSettings,
    "remoteProjects" | "autoStatus" | "dispatcher" | "defaultEngine"
  >
> & {
  engineUpdates?: Array<{ id: string; command?: string; label?: string }>
  addEngine?: { id: string; command: string; label?: string }
  removeEngine?: string
}

export async function fetchSettings(): Promise<WebSettings> {
  return api.get<WebSettings>("/api/settings", { label: "load settings" })
}

/** Best-effort default engine lookup for task creation entry points. */
export async function fetchDefaultEngine(): Promise<string | null> {
  try {
    const settings = await fetchSettings()
    return typeof settings.defaultEngine === "string" &&
      settings.defaultEngine.trim()
      ? settings.defaultEngine.trim()
      : null
  } catch {
    return null
  }
}

export async function saveSettings(
  patch: WebSettingsPatch,
): Promise<WebSettings> {
  return api.patch<WebSettings>("/api/settings", patch, {
    label: "save settings",
  })
}
