import { accessSync, constants as fsConstants, mkdirSync } from "node:fs"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type EngineAccountStatus,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
} from "../../engine/account-detect"
import { VENDOR_LABEL, defaultEngineCommand, engineCommandKey, engineNameKey } from "../../engine/interactive-command"
import { submitFeedback } from "../../lib/feedback"
import { ARCHIVED_HISTORY_PREVIEW_KEY } from "../../state/archived-history"
import { AUTO_STATUS_KEY } from "../../state/auto-status"
import { DISPATCHER_KEY } from "../../state/dispatcher"
import { getGlobalDefaultVendor, setGlobalDefaultVendor } from "../../state/vendor-prefs"
import {
  PROJECT_DIR_TOKEN,
  PROJECT_SIBLING_BASE,
  WORKTREE_BASE_CUSTOM_KEY,
  WORKTREE_BASE_KEY,
  type WorktreeBaseKind,
  hasProjectDirToken,
  normalizeWorktreeBase,
  worktreeBaseKindOf,
} from "../../state/worktree-base"
import { ZEN_KEEP_TASKS_KEY } from "../../state/zen"
import { DEFAULT_TASK_VENDOR, type VendorId } from "../../types/task"
import { ALL_VENDORS, isBuiltinVendor } from "../../types/vendor"
import type { KVContext } from "../context/kv"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, useTheme } from "../context/theme"
import { type LocaleId, currentLang, setLocaleLang, t } from "../i18n"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  type EditorKind,
  normalizeEditorKind,
} from "../lib/editor-prefs"
import { useBindings } from "../lib/keymap"
import { LOCALE_KEY } from "../lib/persisted-ui-prefs"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  type SettingsSurface,
  normalizeSettingsSurface,
} from "../lib/settings-surface"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { RenameTaskDialog } from "./rename-task-dialog"
import { confirmResetState, confirmRestartDaemon, hasRestartableDaemon } from "./settings-dialog/actions"
import {
  type NavLevel,
  SECTIONS,
  type SectionId,
  type SettingsRow,
  humanizeSlug,
  rowAt,
  sectionRows,
} from "./settings-dialog/model"
import {
  AccountsSettingsSection,
  DevSettingsSection,
  EngineSettingsSection,
  FeedbackSettingsSection,
  GeneralSettingsSection,
  KeybindingsSettingsSection,
  SettingsSectionSidebar,
} from "./settings-dialog/sections"

export type SettingsDialogProps = {
  kv: KVContext
  orchestrator?: KobeOrchestrator
  onVisualPrefsChange?: () => void
  onClose: () => void
  standalone?: boolean
}

export function SettingsDialog(props: SettingsDialogProps) {
  const dialog = useDialog()
  const themeCtx = useTheme()
  const renderer = useRenderer()
  const { theme } = themeCtx
  const [level, setLevel] = createSignal<NavLevel>("sidebar")
  const [section, setSection] = createSignal<SectionId>("general")
  const [cursor, setCursor] = createSignal(0)
  const [bodyRow, setBodyRow] = createSignal(0)
  const [feedbackTitle, setFeedbackTitle] = createSignal("")
  const [feedbackBody, setFeedbackBody] = createSignal("")
  const [feedbackStatus, setFeedbackStatus] = createSignal("")
  const themeNames = createMemo<readonly string[]>(() => themeCtx.all().slice().sort())
  const [, setThemeCursor] = createSignal(
    Math.max(
      0,
      themeNames().findIndex((n) => n === themeCtx.selected),
    ),
  )
  const hasDaemon = hasRestartableDaemon(props.orchestrator)

  const [claudeStatus, setClaudeStatus] = createSignal<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codexStatus, setCodexStatus] = createSignal<EngineAccountStatus<CodexAccount> | null>(null)
  const [copilotStatus, setCopilotStatus] = createSignal<EngineAccountStatus<CopilotAccount> | null>(null)
  let accountsProbed = false
  createEffect(() => {
    if (section() !== "accounts" || accountsProbed) return
    accountsProbed = true
    void detectClaudeAccount().then(setClaudeStatus)
    void detectCodexAccount().then(setCodexStatus)
    void detectCopilotAccount().then(setCopilotStatus)
  })

  function bodyRows(): SettingsRow[] {
    return sectionRows(section(), {
      themeNames: themeNames(),
      focusAccentSlots: FOCUS_ACCENT_SLOTS,
      engineList: engineList(),
      hasDaemon,
    })
  }

  function bodyRowCount(): number {
    return bodyRows().length
  }

  function settingsSurface(): SettingsSurface {
    return normalizeSettingsSurface(props.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
  }

  function selectTheme(name: string): void {
    if (themeCtx.selected === name) return
    if (!themeCtx.set(name)) return
    props.kv.set("activeTheme", name)
    props.onVisualPrefsChange?.()
  }

  function currentLocale(): LocaleId {
    return currentLang()
  }

  function selectLanguage(locale: LocaleId): void {
    if (currentLang() === locale) return
    setLocaleLang(locale)
    props.kv.set(LOCALE_KEY, locale)
    props.onVisualPrefsChange?.()
  }

  function setTransparentBackground(next: boolean): void {
    if (themeCtx.transparentBackground === next) return
    themeCtx.setTransparentBackground(next)
    props.kv.set("transparentBackground", next)
    props.onVisualPrefsChange?.()
  }

  function toggleTransparent(): void {
    setTransparentBackground(!themeCtx.transparentBackground)
  }

  function selectFocusAccent(slot: FocusAccentSlot): void {
    if (themeCtx.focusAccent === slot) return
    themeCtx.setFocusAccent(slot)
    props.kv.set("focusAccent", slot)
    props.onVisualPrefsChange?.()
  }

  function selectSurface(surface: SettingsSurface): void {
    props.kv.set(SETTINGS_SURFACE_KEY, surface)
  }

  function toastEnabled(): boolean {
    return (props.kv.get("notifications.toast.enabled", true) as boolean) !== false
  }

  function soundEnabled(): boolean {
    return (props.kv.get("notifications.sound.enabled", true) as boolean) !== false
  }

  function toggleToast(): void {
    props.kv.set("notifications.toast.enabled", !toastEnabled())
  }

  function toggleSound(): void {
    props.kv.set("notifications.sound.enabled", !soundEnabled())
  }

  function zenKeepsTasks(): boolean {
    return props.kv.get(ZEN_KEEP_TASKS_KEY, true) !== false
  }

  function toggleZenKeepsTasks(): void {
    props.kv.set(ZEN_KEEP_TASKS_KEY, !zenKeepsTasks())
  }

  function remoteProjectsEnabled(): boolean {
    return props.kv.get("experimental.remoteProjects", false) === true
  }

  function toggleRemoteProjects(): void {
    props.kv.set("experimental.remoteProjects", !remoteProjectsEnabled())
  }

  function autoStatusOn(): boolean {
    return props.kv.get(AUTO_STATUS_KEY, false) === true
  }

  function toggleAutoStatus(): void {
    props.kv.set(AUTO_STATUS_KEY, !autoStatusOn())
  }

  function dispatcherOn(): boolean {
    return props.kv.get(DISPATCHER_KEY, false) === true
  }

  function toggleDispatcher(): void {
    props.kv.set(DISPATCHER_KEY, !dispatcherOn())
  }

  function archivedHistoryOn(): boolean {
    return props.kv.get(ARCHIVED_HISTORY_PREVIEW_KEY, false) === true
  }

  function toggleArchivedHistory(): void {
    props.kv.set(ARCHIVED_HISTORY_PREVIEW_KEY, !archivedHistoryOn())
  }

  function customEngines(): string[] {
    const raw = props.kv.get("customEngineIds", [])
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []
  }
  function engineList(): VendorId[] {
    return [...ALL_VENDORS, ...customEngines()]
  }
  function engineOverride(vendor: VendorId): string {
    const v = props.kv.get(engineCommandKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineCommandText(vendor: VendorId): string {
    return engineOverride(vendor) || defaultEngineCommand(vendor).join(" ")
  }
  function engineIsDefault(vendor: VendorId): boolean {
    return isBuiltinVendor(vendor) && engineOverride(vendor).length === 0 && !engineNameIsCustom(vendor)
  }
  function engineNameOverride(vendor: VendorId): string {
    const v = props.kv.get(engineNameKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineNameIsCustom(vendor: VendorId): boolean {
    return engineNameOverride(vendor).length > 0
  }
  function engineName(vendor: VendorId): string {
    return engineNameOverride(vendor) || VENDOR_LABEL[vendor] || vendor
  }
  const [defaultEngine, setDefaultEngineSig] = createSignal<VendorId>(getGlobalDefaultVendor() ?? DEFAULT_TASK_VENDOR)
  function isDefaultEngine(vendor: VendorId): boolean {
    return defaultEngine() === vendor
  }
  function setEngineDefault(vendor: VendorId): void {
    setGlobalDefaultVendor(vendor)
    props.kv.set("defaultVendor", vendor)
    setDefaultEngineSig(vendor)
  }
  async function editEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineCommandText(vendor), {
      dialogTitle: `${engineName(vendor)} launch command`,
      fieldLabel: "command",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    props.kv.set(engineCommandKey(vendor), next.trim())
  }
  async function renameEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineName(vendor), {
      dialogTitle: `${engineName(vendor)} display name (blank = default)`,
      fieldLabel: "name",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    props.kv.set(engineNameKey(vendor), next.trim())
  }
  function resetEngine(vendor: VendorId): void {
    props.kv.set(engineCommandKey(vendor), "")
    props.kv.set(engineNameKey(vendor), "")
    if (!isBuiltinVendor(vendor)) {
      props.kv.set(
        "customEngineIds",
        customEngines().filter((id) => id !== vendor),
      )
      setBodyRow((r) => Math.max(0, Math.min(r, engineList().length)))
    }
  }
  async function addEngineFlow(): Promise<void> {
    const idRaw = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: "Add engine",
      fieldLabel: "id",
      submitLabel: "next",
      placeholder: "lowercase slug, e.g. aider",
    })
    if (idRaw === undefined) return
    const id = idRaw.trim().toLowerCase()
    if (!id || isBuiltinVendor(id) || customEngines().includes(id)) return
    const command = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: `Add engine · ${id}`,
      fieldLabel: "command",
      submitLabel: "next",
      placeholder: "e.g. aider --model sonnet",
    })
    if (command === undefined) return
    const name = await RenameTaskDialog.show(dialog, id, {
      dialogTitle: `Add engine · ${id}`,
      fieldLabel: "name",
      submitLabel: "add",
      allowEmpty: true,
    })
    props.kv.set("customEngineIds", [...customEngines(), id])
    if (command.trim()) props.kv.set(engineCommandKey(id), command.trim())
    const typedName = name?.trim() ?? ""
    props.kv.set(engineNameKey(id), typedName && typedName !== id ? typedName : humanizeSlug(id))
  }
  function currentEngineRow(): VendorId | null {
    if (section() !== "engines" || level() !== "body") return null
    const row = rowAt(bodyRows(), bodyRow())
    return row?.kind === "engine" ? row.vendor : null
  }

  function editorKind(): EditorKind {
    return normalizeEditorKind(props.kv.get(EDITOR_KIND_KEY, DEFAULT_EDITOR_KIND))
  }
  function cycleEditorKind(): void {
    const i = EDITOR_KINDS.indexOf(editorKind())
    const next = EDITOR_KINDS[(i + 1) % EDITOR_KINDS.length]
    if (next) props.kv.set(EDITOR_KIND_KEY, next)
  }
  function editorCustomCommand(): string {
    const v = props.kv.get(EDITOR_CUSTOM_KEY, "")
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
    props.kv.set(EDITOR_CUSTOM_KEY, cmd)
    if (cmd) props.kv.set(EDITOR_KIND_KEY, "custom")
  }

  function worktreeBasePath(): string {
    const v = props.kv.get(WORKTREE_BASE_KEY, "")
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
    const v = props.kv.get(WORKTREE_BASE_CUSTOM_KEY, "")
    const remembered = typeof v === "string" ? v.trim() : ""
    return remembered || (worktreeKind() === "custom" ? worktreeBasePath().trim() : "")
  }
  function cycleWorktreeBase(): void {
    const kind = worktreeKind()
    if (kind === "default") {
      props.kv.set(WORKTREE_BASE_KEY, PROJECT_SIBLING_BASE)
    } else if (kind === "nextToProject") {
      props.kv.set(WORKTREE_BASE_KEY, worktreeCustomPath())
    } else {
      props.kv.set(WORKTREE_BASE_CUSTOM_KEY, worktreeBasePath().trim())
      props.kv.set(WORKTREE_BASE_KEY, "")
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
    props.kv.set(WORKTREE_BASE_CUSTOM_KEY, raw)
    if (raw) props.kv.set(WORKTREE_BASE_KEY, raw)
    else if (worktreeKind() === "custom") props.kv.set(WORKTREE_BASE_KEY, "")
  }

  async function sendFeedback(): Promise<void> {
    setFeedbackStatus("submitting...")
    try {
      const result = submitFeedback({ title: feedbackTitle(), body: feedbackBody() })
      setFeedbackStatus(`sent: ${result.url}`)
      setFeedbackTitle("")
      setFeedbackBody("")
      setBodyRow(0)
    } catch (err) {
      setFeedbackStatus(`error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const editingFeedback = () => section() === "feedback" && level() === "body"

  function feedbackFieldStep(delta: 1 | -1): void {
    const next = bodyRow() + delta
    if (next < 0 || next > 2) {
      setLevel("sidebar")
      return
    }
    setBodyRow(next)
  }

  function enterBody(): void {
    if (level() !== "sidebar" || bodyRowCount() === 0) return
    setLevel("body")
    setBodyRow(0)
    if (section() === "general") setThemeCursor(0)
  }

  function moveCursor(delta: number): void {
    if (level() === "sidebar") {
      const next = (cursor() + delta + SECTIONS.length) % SECTIONS.length
      setCursor(next)
      const nextSection = SECTIONS[next]
      if (nextSection) {
        setSection(nextSection.id)
        setBodyRow(0)
      }
      return
    }
    const len = bodyRowCount()
    if (len === 0) return
    const next = (bodyRow() + delta + len) % len
    setBodyRow(next)
    if (rowAt(bodyRows(), next)?.kind === "theme") setThemeCursor(next)
  }

  function switchSection(id: SectionId): void {
    setSection(id)
    setCursor(SECTIONS.findIndex((s) => s.id === id))
    setBodyRow(0)
    setLevel("sidebar")
  }

  const rowActivators: { [K in SettingsRow["kind"]]: (row: Extract<SettingsRow, { kind: K }>) => void } = {
    theme: (row) => selectTheme(row.name),
    language: (row) => selectLanguage(row.locale),
    transparent: () => toggleTransparent(),
    focusAccent: (row) => selectFocusAccent(row.slot),
    toast: () => toggleToast(),
    sound: () => toggleSound(),
    zenKeepTasks: () => toggleZenKeepsTasks(),
    surface: (row) => selectSurface(row.surface),
    editorKind: () => cycleEditorKind(),
    editorCustom: () => void editEditorCustom(),
    worktreeBase: () => cycleWorktreeBase(),
    worktreeCustom: () => void editWorktreeCustom(),
    engine: (row) => void editEngine(row.vendor),
    engineAdd: () => void addEngineFlow(),
    feedbackTitle: () => setBodyRow(0),
    feedbackBody: () => setBodyRow(1),
    feedbackSend: () => void sendFeedback(),
    devReset: () => void confirmResetState(dialog, props.kv, renderer),
    devRestartDaemon: () => void confirmRestartDaemon(dialog, props.orchestrator, renderer),
    devRemoteProjects: () => toggleRemoteProjects(),
    devAutoStatus: () => toggleAutoStatus(),
    devDispatcher: () => toggleDispatcher(),
    devArchivedHistory: () => toggleArchivedHistory(),
  }

  function activateBodyRow(): void {
    const row = rowAt(bodyRows(), bodyRow())
    if (!row) return
    ;(rowActivators[row.kind] as (row: SettingsRow) => void)(row)
  }

  useBindings(() => ({
    enabled: (!props.standalone || dialog.stack.length === 0) && !editingFeedback(),
    bindings: [
      { key: "down", cmd: () => moveCursor(1) },
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "j", cmd: () => moveCursor(1) },
      { key: "k", cmd: () => moveCursor(-1) },
      { key: "tab", cmd: () => moveCursor(1) },
      { key: "right", cmd: enterBody },
      { key: "l", cmd: enterBody },
      { key: "left", cmd: () => setLevel("sidebar") },
      { key: "h", cmd: () => setLevel("sidebar") },
      {
        key: "return",
        cmd: () => {
          if (level() === "sidebar") {
            enterBody()
            return
          }
          activateBodyRow()
        },
      },
      {
        key: "t",
        cmd: toggleTransparent,
      },
      {
        key: "r",
        cmd: () => {
          const v = currentEngineRow()
          if (v) void renameEngine(v)
        },
      },
      {
        key: "x",
        cmd: () => {
          const v = currentEngineRow()
          if (v) resetEngine(v)
        },
      },
      {
        key: "d",
        cmd: () => {
          const v = currentEngineRow()
          if (v) setEngineDefault(v)
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: editingFeedback(),
    bindings: [
      { key: "tab", cmd: () => feedbackFieldStep(1) },
      { key: "shift+tab", cmd: () => feedbackFieldStep(-1) },
    ],
  }))
  useBindings(() => ({
    enabled: editingFeedback() && bodyRow() === 2,
    bindings: [{ key: "return", cmd: () => void sendFeedback() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("settings.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          {t("settings.esc")}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <SettingsSectionSidebar level={level} cursor={cursor} switchSection={switchSection} />
        <box flexGrow={1} flexShrink={1} flexDirection="column" gap={1}>
          <Show when={section() === "general"}>
            <GeneralSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              themeNames={themeNames}
              setThemeCursor={setThemeCursor}
              selectTheme={selectTheme}
              currentLocale={currentLocale}
              selectLanguage={selectLanguage}
              toggleTransparent={toggleTransparent}
              selectFocusAccent={selectFocusAccent}
              toastEnabled={toastEnabled}
              soundEnabled={soundEnabled}
              toggleToast={toggleToast}
              toggleSound={toggleSound}
              zenKeepsTasks={zenKeepsTasks}
              toggleZenKeepsTasks={toggleZenKeepsTasks}
              settingsSurface={settingsSurface}
              selectSurface={selectSurface}
              editorKind={editorKind}
              cycleEditorKind={cycleEditorKind}
              editorCustomCommand={editorCustomCommand}
              editEditorCustom={() => void editEditorCustom()}
              worktreeKind={worktreeKind}
              worktreeKindLabel={worktreeKindLabel}
              cycleWorktreeBase={cycleWorktreeBase}
              worktreeCustomPath={worktreeCustomPath}
              editWorktreeCustom={() => void editWorktreeCustom()}
            />
          </Show>
          <Show when={section() === "engines"}>
            <EngineSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              vendors={engineList()}
              isCustom={(v) => !isBuiltinVendor(v)}
              displayName={engineName}
              commandText={engineCommandText}
              isDefault={engineIsDefault}
              isDefaultEngine={isDefaultEngine}
              editEngine={(v) => void editEngine(v)}
              renameEngine={(v) => void renameEngine(v)}
              resetEngine={resetEngine}
              onAddEngine={() => void addEngineFlow()}
            />
          </Show>
          <Show when={section() === "accounts"}>
            <AccountsSettingsSection
              claudeStatus={claudeStatus}
              codexStatus={codexStatus}
              copilotStatus={copilotStatus}
            />
          </Show>
          <Show when={section() === "keys"}>
            <KeybindingsSettingsSection />
          </Show>
          <Show when={section() === "feedback"}>
            <FeedbackSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              title={feedbackTitle}
              setTitle={(v) => {
                setFeedbackTitle(v)
                setFeedbackStatus("")
              }}
              body={feedbackBody}
              setBody={(v) => {
                setFeedbackBody(v)
                setFeedbackStatus("")
              }}
              status={feedbackStatus}
              onTitleSubmit={() => setBodyRow(1)}
              submit={() => void sendFeedback()}
            />
          </Show>
          <Show when={section() === "dev"}>
            <DevSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              hasDaemon={hasDaemon}
              confirmReset={() => void confirmResetState(dialog, props.kv, renderer)}
              confirmRestartDaemon={() => void confirmRestartDaemon(dialog, props.orchestrator, renderer)}
              remoteProjectsEnabled={remoteProjectsEnabled}
              toggleRemoteProjects={toggleRemoteProjects}
              autoStatusEnabled={autoStatusOn}
              toggleAutoStatus={toggleAutoStatus}
              dispatcherEnabled={dispatcherOn}
              toggleDispatcher={toggleDispatcher}
              archivedHistoryEnabled={archivedHistoryOn}
              toggleArchivedHistory={toggleArchivedHistory}
            />
          </Show>
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>{editingFeedback() ? t("settings.nav.feedback") : t("settings.nav.default")}</text>
      </box>
    </box>
  )
}

SettingsDialog.show = (
  dialog: DialogContext,
  kv: KVContext,
  orchestrator?: KobeOrchestrator,
): Promise<{ visualPrefsChanged: boolean }> => {
  let visualPrefsChanged = false
  return new Promise<{ visualPrefsChanged: boolean }>((resolve) => {
    dialog.replace(
      () => (
        <SettingsDialog
          kv={kv}
          orchestrator={orchestrator}
          onVisualPrefsChange={() => {
            visualPrefsChanged = true
          }}
          onClose={() => resolve({ visualPrefsChanged })}
        />
      ),
      () => resolve({ visualPrefsChanged }),
    )
  })
}
