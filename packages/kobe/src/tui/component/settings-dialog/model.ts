import type { VendorId } from "../../../types/vendor"
import type { FocusAccentSlot } from "../../context/theme-core"
import { LOCALES, type LocaleId } from "../../i18n/catalog"

export type NavLevel = "sidebar" | "body"

export type SectionId = "general" | "engines" | "accounts" | "keys" | "feedback" | "dev"

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "engines", label: "Engines" },
  { id: "accounts", label: "Accounts" },
  { id: "keys", label: "Keybindings" },
  { id: "feedback", label: "Feedback" },
  { id: "dev", label: "Dev" },
]

export type SettingsRow =
  | { id: string; kind: "theme"; name: string }
  | { id: string; kind: "language"; locale: LocaleId }
  | { id: "transparent"; kind: "transparent" }
  | { id: string; kind: "focusAccent"; slot: FocusAccentSlot }
  | { id: "toast"; kind: "toast" }
  | { id: "sound"; kind: "sound" }
  | { id: "zen-keep-tasks"; kind: "zenKeepTasks" }
  | { id: string; kind: "surface"; surface: "chattab" | "taskpanel" }
  | { id: "editor-kind"; kind: "editorKind" }
  | { id: "editor-custom"; kind: "editorCustom" }
  | { id: "worktree-base"; kind: "worktreeBase" }
  | { id: "worktree-custom"; kind: "worktreeCustom" }
  | { id: string; kind: "engine"; vendor: VendorId }
  | { id: "add-engine"; kind: "engineAdd" }
  | { id: "feedback-title"; kind: "feedbackTitle" }
  | { id: "feedback-body"; kind: "feedbackBody" }
  | { id: "feedback-send"; kind: "feedbackSend" }
  | { id: "dev-reset"; kind: "devReset" }
  | { id: "dev-restart"; kind: "devRestartDaemon" }
  | { id: "remote-projects"; kind: "devRemoteProjects" }
  | { id: "auto-status"; kind: "devAutoStatus" }
  | { id: "dispatcher"; kind: "devDispatcher" }
  | { id: "archived-history"; kind: "devArchivedHistory" }

export function themeRowId(name: string): string {
  return `theme:${name}`
}

export function languageRowId(locale: LocaleId): string {
  return `language:${locale}`
}

export function focusAccentRowId(slot: FocusAccentSlot): string {
  return `accent:${slot}`
}

export function engineRowId(vendor: VendorId): string {
  return `engine:${vendor}`
}

export function surfaceRowId(surface: "chattab" | "taskpanel"): string {
  return `surface:${surface}`
}

export type SettingsRowsInput = {
  themeNames: readonly string[]
  focusAccentSlots: readonly FocusAccentSlot[]
  engineList: readonly VendorId[]
  hasDaemon: boolean
}

export function generalRows(input: Pick<SettingsRowsInput, "themeNames" | "focusAccentSlots">): SettingsRow[] {
  return [
    ...input.themeNames.map((name): SettingsRow => ({ id: themeRowId(name), kind: "theme", name })),
    ...LOCALES.map((l): SettingsRow => ({ id: languageRowId(l.id), kind: "language", locale: l.id })),
    { id: "transparent", kind: "transparent" },
    ...input.focusAccentSlots.map((slot): SettingsRow => ({ id: focusAccentRowId(slot), kind: "focusAccent", slot })),
    { id: "toast", kind: "toast" },
    { id: "sound", kind: "sound" },
    { id: "zen-keep-tasks", kind: "zenKeepTasks" },
    { id: surfaceRowId("chattab"), kind: "surface", surface: "chattab" },
    { id: surfaceRowId("taskpanel"), kind: "surface", surface: "taskpanel" },
    { id: "editor-kind", kind: "editorKind" },
    { id: "editor-custom", kind: "editorCustom" },
    { id: "worktree-base", kind: "worktreeBase" },
    { id: "worktree-custom", kind: "worktreeCustom" },
  ]
}

export function engineRows(engineList: readonly VendorId[]): SettingsRow[] {
  return [
    ...engineList.map((vendor): SettingsRow => ({ id: engineRowId(vendor), kind: "engine", vendor })),
    { id: "add-engine", kind: "engineAdd" },
  ]
}

export function feedbackRows(): SettingsRow[] {
  return [
    { id: "feedback-title", kind: "feedbackTitle" },
    { id: "feedback-body", kind: "feedbackBody" },
    { id: "feedback-send", kind: "feedbackSend" },
  ]
}

export function devRows(hasDaemon: boolean): SettingsRow[] {
  return [
    { id: "dev-reset", kind: "devReset" },
    ...(hasDaemon ? [{ id: "dev-restart", kind: "devRestartDaemon" } as const] : []),
    { id: "remote-projects", kind: "devRemoteProjects" },
    { id: "auto-status", kind: "devAutoStatus" },
    { id: "dispatcher", kind: "devDispatcher" },
    { id: "archived-history", kind: "devArchivedHistory" },
  ]
}

export function sectionRows(section: SectionId, input: SettingsRowsInput): SettingsRow[] {
  switch (section) {
    case "general":
      return generalRows(input)
    case "engines":
      return engineRows(input.engineList)
    case "accounts":
    case "keys":
      return []
    case "feedback":
      return feedbackRows()
    case "dev":
      return devRows(input.hasDaemon)
  }
}

export function bodyRowCount(section: SectionId, input: SettingsRowsInput): number {
  return sectionRows(section, input).length
}

export function rowIndex(rows: readonly SettingsRow[], id: string): number {
  return rows.findIndex((row) => row.id === id)
}

export function rowAt(rows: readonly SettingsRow[], index: number): SettingsRow | undefined {
  return rows[index]
}

export function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
