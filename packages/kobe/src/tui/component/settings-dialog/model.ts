/**
 * Pure data + helpers for settings-dialog (v0.6).
 *
 * v0.5 had Accounts (claude/codex/gemini login status) and Codex
 * (app-server / exec backend) sections; both depended on engine
 * modules that v0.6 deleted, so the dialog shrinks to General + Dev.
 */

import type { FocusAccentSlot } from "../../context/theme"

export type NavLevel = "sidebar" | "body"

export type SectionId = "general" | "dev"

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "dev", label: "Dev" },
]

export const FOCUS_ACCENT_LABEL: Record<FocusAccentSlot, string> = {
  primary: "Primary (brand accent)",
  success: "Success (legacy green)",
  info: "Info (cool blue)",
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
