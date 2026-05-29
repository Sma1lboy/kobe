/**
 * Pure data + helpers for settings-dialog (v0.6).
 *
 * v0.5 had a Codex (app-server / exec backend) section that depended on
 * engine modules v0.6 deleted, so it's gone. Accounts came back in
 * KOB-249 (read-only claude/codex/copilot login detection) alongside
 * the Engines launch-command section.
 */

import { ALL_VENDORS } from "../../../types/vendor"
import type { FocusAccentSlot } from "../../context/theme"

export type NavLevel = "sidebar" | "body"

export type SectionId = "general" | "engines" | "accounts" | "dev"

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "engines", label: "Engines" },
  { id: "accounts", label: "Accounts" },
  { id: "dev", label: "Dev" },
]

/** One row per vendor — each edits that engine's launch command. */
export function engineRowCount(): number {
  return ALL_VENDORS.length
}

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
  if (section === "engines") return engineRowCount()
  // Accounts is a read-only display — no navigable rows.
  if (section === "accounts") return 0
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
