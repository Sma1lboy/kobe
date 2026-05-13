import type { CodexBackend } from "../../../engine/codex-local/app-server"
import type { FocusAccentSlot } from "../../context/theme"

export type NavLevel = "sidebar" | "body"

export type SectionId = "general" | "accounts" | "codex" | "dev"

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "codex", label: "Codex" },
  { id: "dev", label: "Dev" },
]

export const FOCUS_ACCENT_LABEL: Record<FocusAccentSlot, string> = {
  primary: "Primary (brand accent)",
  success: "Success (legacy green)",
  info: "Info (cool blue)",
}

export const CODEX_BACKENDS: readonly CodexBackend[] = ["app-server", "exec"]

export const CODEX_BACKEND_LABEL: Record<CodexBackend, string> = {
  "app-server": "App server (default)",
  exec: "exec --json",
}

export const CODEX_BACKEND_DESCRIPTION: Record<CodexBackend, string> = {
  "app-server": "Codex app-server JSON-RPC; keeps official thread/session state and token usage.",
  exec: "Fallback path; starts codex exec --json for each turn and resumes the saved session id.",
}

export function devRowCount(hasDaemon: boolean): number {
  return hasDaemon ? 2 : 1
}

export function generalRowCount(themeCount: number, focusAccentCount: number): number {
  return themeCount + 1 + focusAccentCount + 2
}

export function bodyRowCount(
  section: SectionId,
  themeCount: number,
  focusAccentCount: number,
  hasDaemon: boolean,
): number {
  if (section === "general") return generalRowCount(themeCount, focusAccentCount)
  if (section === "codex") return CODEX_BACKENDS.length
  if (section === "dev") return devRowCount(hasDaemon)
  return 0
}

export function transparentRowIndex(themeCount: number): number {
  return themeCount
}

export function focusAccentRowIndex(bodyRow: number, themeCount: number, focusAccentCount: number): number | null {
  const offset = themeCount + 1
  const i = bodyRow - offset
  if (i < 0 || i >= focusAccentCount) return null
  return i
}

export function toastRowIndex(themeCount: number, focusAccentCount: number): number {
  return themeCount + 1 + focusAccentCount
}

export function soundRowIndex(themeCount: number, focusAccentCount: number): number {
  return toastRowIndex(themeCount, focusAccentCount) + 1
}

export function codexEnvOverride(): CodexBackend | null {
  if (process.env.KOBE_CODEX_BACKEND === "exec") return "exec"
  if (process.env.KOBE_CODEX_BACKEND === "app-server" || process.env.KOBE_CODEX_APP_SERVER === "1") {
    return "app-server"
  }
  return null
}
