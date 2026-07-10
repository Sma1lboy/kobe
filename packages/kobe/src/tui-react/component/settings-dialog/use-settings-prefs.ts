/**
 * kv-backed preference helpers for the React settings dialog (issue #15,
 * G3) — the General/Dev getter+toggle closures split out of `./index.tsx`
 * to keep it under the file-size cap. Same kv keys, defaults, and
 * validation flows as the Solid `src/tui/component/settings-dialog.tsx`
 * (see that file's commentary for the full design notes). All reads are
 * plain `kv.get` — the KVProvider re-renders the tree on every `kv.set`,
 * so the values are recomputed per render.
 */

import { accessSync, constants as fsConstants, mkdirSync } from "node:fs"
import { ARCHIVED_HISTORY_PREVIEW_KEY } from "../../../state/archived-history"
import { AUTO_STATUS_KEY } from "../../../state/auto-status"
import { DISPATCHER_KEY } from "../../../state/dispatcher"
import { DEFAULT_SCROLLBACK_ROWS, SCROLLBACK_ROWS_KEY, normalizeScrollbackRows } from "../../../state/scrollback"
import { SPLIT_STYLE_KEY, type SplitStyle, normalizeSplitStyle } from "../../../state/split-style"
import {
  PROJECT_DIR_TOKEN,
  PROJECT_SIBLING_BASE,
  WORKTREE_BASE_CUSTOM_KEY,
  WORKTREE_BASE_KEY,
  type WorktreeBaseKind,
  hasProjectDirToken,
  normalizeWorktreeBase,
  worktreeBaseKindOf,
} from "../../../state/worktree-base"
import { ZEN_KEEP_TASKS_KEY } from "../../../state/zen"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  type EditorKind,
  normalizeEditorKind,
} from "../../../tui/lib/editor-prefs"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  type SettingsSurface,
  normalizeSettingsSurface,
} from "../../../tui/lib/settings-surface"
import type { KVContext } from "../../context/kv"
import { useT } from "../../i18n"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { RenameTaskDialog } from "../rename-task-dialog"

export function useSettingsPrefs(kv: KVContext, dialog: DialogContext) {
  const t = useT()

  function settingsSurface(): SettingsSurface {
    return normalizeSettingsSurface(kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
  }
  function selectSurface(surface: SettingsSurface): void {
    kv.set(SETTINGS_SURFACE_KEY, surface)
  }

  function toastEnabled(): boolean {
    return (kv.get("notifications.toast.enabled", true) as boolean) !== false
  }
  function soundEnabled(): boolean {
    return (kv.get("notifications.sound.enabled", true) as boolean) !== false
  }
  function toggleToast(): void {
    kv.set("notifications.toast.enabled", !toastEnabled())
  }
  function toggleSound(): void {
    kv.set("notifications.sound.enabled", !soundEnabled())
  }

  // Appearance: how split leaves draw — full box frames or single dividers.
  function splitStyle(): SplitStyle {
    return normalizeSplitStyle(kv.get(SPLIT_STYLE_KEY))
  }
  function selectSplitStyle(style: SplitStyle): void {
    kv.set(SPLIT_STYLE_KEY, style)
  }

  // Zen mode: whether collapsing to the engine pane keeps the Tasks rail.
  function zenKeepsTasks(): boolean {
    return kv.get(ZEN_KEEP_TASKS_KEY, true) !== false
  }
  function toggleZenKeepsTasks(): void {
    kv.set(ZEN_KEEP_TASKS_KEY, !zenKeepsTasks())
  }

  // Experimental flags (Dev section) — same keys/defaults as the Solid dialog.
  function remoteProjectsEnabled(): boolean {
    return kv.get("experimental.remoteProjects", false) === true
  }
  function toggleRemoteProjects(): void {
    kv.set("experimental.remoteProjects", !remoteProjectsEnabled())
  }
  function autoStatusOn(): boolean {
    return kv.get(AUTO_STATUS_KEY, false) === true
  }
  function toggleAutoStatus(): void {
    kv.set(AUTO_STATUS_KEY, !autoStatusOn())
  }
  function dispatcherOn(): boolean {
    return kv.get(DISPATCHER_KEY, false) === true
  }
  function toggleDispatcher(): void {
    kv.set(DISPATCHER_KEY, !dispatcherOn())
  }
  function archivedHistoryOn(): boolean {
    return kv.get(ARCHIVED_HISTORY_PREVIEW_KEY, false) === true
  }
  function toggleArchivedHistory(): void {
    kv.set(ARCHIVED_HISTORY_PREVIEW_KEY, !archivedHistoryOn())
  }

  // Editor preference: which editor the file tree's `e` key launches.
  function editorKind(): EditorKind {
    return normalizeEditorKind(kv.get(EDITOR_KIND_KEY, DEFAULT_EDITOR_KIND))
  }
  function cycleEditorKind(): void {
    const i = EDITOR_KINDS.indexOf(editorKind())
    const next = EDITOR_KINDS[(i + 1) % EDITOR_KINDS.length]
    if (next) kv.set(EDITOR_KIND_KEY, next)
  }
  function editorCustomCommand(): string {
    const v = kv.get(EDITOR_CUSTOM_KEY, "")
    return typeof v === "string" ? v : ""
  }
  async function editEditorCustom(): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, editorCustomCommand(), {
      dialogTitle: "Custom editor command (use {file} for the path)",
      fieldLabel: "command",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    const cmd = next.trim()
    kv.set(EDITOR_CUSTOM_KEY, cmd)
    // A command typed here should take effect — flip the kind to `custom`.
    if (cmd) kv.set(EDITOR_KIND_KEY, "custom")
  }

  // Terminal scrollback: rows of history each embedded terminal keeps.
  // Applies to terminals spawned after the change (PTYs resolve it at
  // construction — see state/scrollback.ts).
  function scrollbackRows(): number {
    return normalizeScrollbackRows(kv.get(SCROLLBACK_ROWS_KEY, DEFAULT_SCROLLBACK_ROWS))
  }
  async function editScrollbackRows(): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, String(scrollbackRows()), {
      dialogTitle: t("settings.general.scrollbackTitle"),
      fieldLabel: t("settings.general.scrollbackField"),
      submitLabel: "save",
      placeholder: String(DEFAULT_SCROLLBACK_ROWS),
    })
    if (next === undefined) return
    const n = Number.parseInt(next.trim(), 10)
    if (!Number.isFinite(n)) {
      await DialogConfirm.show(
        dialog,
        t("settings.general.scrollbackInvalidTitle"),
        t("settings.general.scrollbackInvalidBody"),
        "cancel",
      )
      return
    }
    kv.set(SCROLLBACK_ROWS_KEY, normalizeScrollbackRows(n))
  }

  // Worktree location: a global override for where new LOCAL task worktrees
  // are created — same preset cycle + validation as the Solid dialog.
  function worktreeBasePath(): string {
    const v = kv.get(WORKTREE_BASE_KEY, "")
    return typeof v === "string" ? v : ""
  }
  const worktreeKind = (): WorktreeBaseKind => worktreeBaseKindOf(worktreeBasePath())
  function worktreeKindLabel(): string {
    const kind = worktreeKind()
    if (kind === "default") return t("settings.general.worktreeKindDefault")
    if (kind === "nextToProject") return t("settings.general.worktreeKindNext")
    return t("settings.general.worktreeKindCustom")
  }
  function worktreeCustomPath(): string {
    const v = kv.get(WORKTREE_BASE_CUSTOM_KEY, "")
    const remembered = typeof v === "string" ? v.trim() : ""
    // A custom path saved before the preset cycle existed lives only in
    // the base key — surface it so the row isn't misleadingly "(unset)".
    return remembered || (worktreeKind() === "custom" ? worktreeBasePath().trim() : "")
  }
  function cycleWorktreeBase(): void {
    const kind = worktreeKind()
    if (kind === "default") {
      kv.set(WORKTREE_BASE_KEY, PROJECT_SIBLING_BASE)
    } else if (kind === "nextToProject") {
      // No remembered custom path → nothing to cycle onto; back to default.
      kv.set(WORKTREE_BASE_KEY, worktreeCustomPath())
    } else {
      kv.set(WORKTREE_BASE_CUSTOM_KEY, worktreeBasePath().trim())
      kv.set(WORKTREE_BASE_KEY, "")
    }
  }
  async function editWorktreeCustom(): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, worktreeCustomPath(), {
      dialogTitle: t("settings.general.worktreeBaseTitle"),
      fieldLabel: t("settings.general.worktreeBaseField"),
      submitLabel: "save",
      placeholder: `${PROJECT_DIR_TOKEN}/../worktrees`,
      allowEmpty: true,
    })
    if (next === undefined) return
    const raw = next.trim()
    // Validate (create + writability check) and refuse to save a bad path —
    // same rationale and rules as the Solid dialog.
    if (raw.includes(PROJECT_DIR_TOKEN)) {
      if (!hasProjectDirToken(raw)) {
        await DialogConfirm.show(
          dialog,
          "Can't use that worktree location",
          `${PROJECT_DIR_TOKEN} only expands as the leading path segment (e.g. ${PROJECT_DIR_TOKEN}/../kobe-worktrees). Keeping the previous setting.`,
          "cancel",
        )
        return
      }
    } else if (raw) {
      const resolved = normalizeWorktreeBase(raw) ?? raw
      try {
        mkdirSync(resolved, { recursive: true })
        accessSync(resolved, fsConstants.W_OK)
      } catch (err) {
        await DialogConfirm.show(
          dialog,
          "Can't use that worktree location",
          `${resolved} isn't usable (${err instanceof Error ? err.message : String(err)}). Keeping the previous setting — pick a writable directory.`,
          "cancel",
        )
        return
      }
    }
    kv.set(WORKTREE_BASE_CUSTOM_KEY, raw)
    if (raw) kv.set(WORKTREE_BASE_KEY, raw)
    else if (worktreeKind() === "custom") kv.set(WORKTREE_BASE_KEY, "")
  }

  return {
    settingsSurface,
    selectSurface,
    toastEnabled,
    toggleToast,
    soundEnabled,
    toggleSound,
    splitStyle,
    selectSplitStyle,
    zenKeepsTasks,
    toggleZenKeepsTasks,
    remoteProjectsEnabled,
    toggleRemoteProjects,
    autoStatusOn,
    toggleAutoStatus,
    dispatcherOn,
    toggleDispatcher,
    archivedHistoryOn,
    toggleArchivedHistory,
    editorKind,
    cycleEditorKind,
    editorCustomCommand,
    editEditorCustom,
    scrollbackRows,
    editScrollbackRows,
    worktreeKind,
    worktreeKindLabel,
    worktreeCustomPath,
    cycleWorktreeBase,
    editWorktreeCustom,
  }
}
