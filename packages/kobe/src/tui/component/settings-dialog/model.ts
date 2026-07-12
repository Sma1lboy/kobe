/**
 * Pure data + helpers for settings-dialog (v0.6).
 *
 * v0.5 had a Codex (app-server / exec backend) section that depended on
 * engine modules v0.6 deleted, so it's gone. Accounts came back
 * (read-only claude/codex/copilot login detection) alongside
 * the Engines launch-command section.
 *
 * Row registry: each section declares an ORDERED list of row descriptors
 * built from the same reactive inputs the dialog already holds (theme
 * names, focus-accent slots, the engine list, hasDaemon). A row's body
 * index IS its position in that list — no offset arithmetic — so adding
 * or reordering a row is a one-line change here, and activation in
 * settings-dialog.tsx becomes a lookup on `row.kind` instead of an
 * index if-chain. This module stays pure (types + data only) so vitest
 * can import it without @opentui.
 */

import { SPLIT_STYLES, type SplitStyle } from "../../../state/split-style"
import type { VendorId } from "../../../types/vendor"
// theme-core (not ../../context/theme): this module is shared with the
// React port, which must not reference the Solid .tsx even type-only.
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

/**
 * One navigable body row. `id` is unique within its section and stable
 * across renders (used by the section views to find a row's index);
 * `kind` is what the dialog's activation lookup dispatches on. Rows
 * with a payload (theme name, accent slot, engine vendor) carry it so
 * activation never has to reverse-engineer it from an index.
 */
export type SettingsRow =
  | { id: string; kind: "theme"; name: string }
  | { id: string; kind: "language"; locale: LocaleId }
  | { id: "transparent"; kind: "transparent" }
  | { id: string; kind: "focusAccent"; slot: FocusAccentSlot }
  | { id: "reduced-motion"; kind: "reducedMotion" }
  | { id: string; kind: "splitStyle"; style: SplitStyle }
  | { id: "toast"; kind: "toast" }
  | { id: "sound"; kind: "sound" }
  | { id: "cross-task"; kind: "crossTask" }
  | { id: "zen-keep-tasks"; kind: "zenKeepTasks" }
  | { id: "editor-kind"; kind: "editorKind" }
  | { id: "editor-custom"; kind: "editorCustom" }
  | { id: "worktree-base"; kind: "worktreeBase" }
  | { id: "worktree-custom"; kind: "worktreeCustom" }
  | { id: "scrollback-rows"; kind: "scrollbackRows" }
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

/** Stable row ids for payload-bearing rows (shared by builders + views). */
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

export function splitStyleRowId(style: SplitStyle): string {
  return `split-style:${style}`
}

/** Everything the registry needs to lay out every section's rows. */
export type SettingsRowsInput = {
  themeNames: readonly string[]
  focusAccentSlots: readonly FocusAccentSlot[]
  /** Built-ins + user-registered custom engines, in display order. */
  engineList: readonly VendorId[]
  hasDaemon: boolean
}

/**
 * General section: themes, transparent toggle, focus accents, toast,
 * sound, the zen-mode toggle, then the editor pair. Order here IS the
 * on-screen order — sections.tsx renders
 * the same sequence.
 */
export function generalRows(input: Pick<SettingsRowsInput, "themeNames" | "focusAccentSlots">): SettingsRow[] {
  return [
    ...input.themeNames.map((name): SettingsRow => ({ id: themeRowId(name), kind: "theme", name })),
    ...LOCALES.map((l): SettingsRow => ({ id: languageRowId(l.id), kind: "language", locale: l.id })),
    { id: "transparent", kind: "transparent" },
    ...input.focusAccentSlots.map((slot): SettingsRow => ({ id: focusAccentRowId(slot), kind: "focusAccent", slot })),
    { id: "reduced-motion", kind: "reducedMotion" },
    ...SPLIT_STYLES.map((style): SettingsRow => ({ id: splitStyleRowId(style), kind: "splitStyle", style })),
    { id: "toast", kind: "toast" },
    { id: "sound", kind: "sound" },
    { id: "cross-task", kind: "crossTask" },
    { id: "zen-keep-tasks", kind: "zenKeepTasks" },
    { id: "editor-kind", kind: "editorKind" },
    { id: "editor-custom", kind: "editorCustom" },
    { id: "worktree-base", kind: "worktreeBase" },
    { id: "worktree-custom", kind: "worktreeCustom" },
    { id: "scrollback-rows", kind: "scrollbackRows" },
  ]
}

/**
 * Engines section: one row per engine (built-ins + custom), plus the
 * trailing "+ Add engine" row. Engine row index === position in
 * `engineList`, matching the section view's <For> order.
 */
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

/**
 * Dev section: Reset (always), Restart (daemon only), then the
 * Experimental remote-projects toggle — kept last so its presence never
 * shifts the rows above it.
 */
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

/**
 * The full registry: a section's ordered navigable rows. Accounts and
 * Keybindings are read-only displays — zero navigable rows.
 */
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

/** Index of a row id within a row list, or -1 when absent. */
export function rowIndex(rows: readonly SettingsRow[], id: string): number {
  return rows.findIndex((row) => row.id === id)
}

/** The row at a body index, or undefined when out of range. */
export function rowAt(rows: readonly SettingsRow[], index: number): SettingsRow | undefined {
  return rows[index]
}

/**
 * Turn a custom-engine slug into a presentable display name: split on
 * `-`/`_` and title-case each word. `my-local-agent` → `My Local Agent`.
 * Used so a custom engine added with no name still reads like the
 * title-cased built-ins instead of its raw lowercase-hyphenated id.
 * (Shared by the Solid and React settings dialogs.)
 */
export function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
