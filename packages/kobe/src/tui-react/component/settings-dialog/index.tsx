/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type EngineAccountStatus,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
} from "../../../engine/account-detect"
import { submitFeedback } from "../../../lib/feedback"
import {
  type NavLevel,
  SECTIONS,
  type SectionId,
  type SettingsRow,
  rowAt,
  sectionRows,
} from "../../../tui/component/settings-dialog/model"
import { LOCALE_KEY } from "../../../tui/lib/persisted-ui-prefs"
import type { VendorId } from "../../../types/task"
import { isBuiltinVendor } from "../../../types/vendor"
import type { KVContext } from "../../context/kv"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, useTheme } from "../../context/theme"
import { type LocaleId, currentLang, setLocaleLang, useT } from "../../i18n"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { confirmResetState, confirmRestartDaemon, hasRestartableDaemon } from "./actions"
import { AccountsSettingsSection, EngineSettingsSection } from "./sections-engines"
import { GeneralSettingsSection, SettingsSectionSidebar } from "./sections-general"
import { DevSettingsSection, FeedbackSettingsSection, KeybindingsSettingsSection } from "./sections-misc"
import { useEngineSettings } from "./use-engine-settings"
import { useSettingsPrefs } from "./use-settings-prefs"

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
  const t = useT()
  const [level, setLevel] = useState<NavLevel>("sidebar")
  const [section, setSection] = useState<SectionId>("general")
  const [cursor, setCursor] = useState(0)
  const [bodyRow, setBodyRow] = useState(0)
  const [feedbackTitle, setFeedbackTitle] = useState("")
  const [feedbackBody, setFeedbackBody] = useState("")
  const [feedbackStatus, setFeedbackStatus] = useState("")
  const themeNames = useMemo<readonly string[]>(() => themeCtx.all().slice().sort(), [themeCtx])
  const hasDaemon = hasRestartableDaemon(props.orchestrator)

  const prefs = useSettingsPrefs(props.kv, dialog)
  const engines = useEngineSettings(props.kv, dialog, (max) => setBodyRow((r) => Math.max(0, Math.min(r, max))))

  const [claudeStatus, setClaudeStatus] = useState<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codexStatus, setCodexStatus] = useState<EngineAccountStatus<CodexAccount> | null>(null)
  const [copilotStatus, setCopilotStatus] = useState<EngineAccountStatus<CopilotAccount> | null>(null)
  const accountsProbed = useRef(false)
  useEffect(() => {
    if (section !== "accounts" || accountsProbed.current) return
    accountsProbed.current = true
    void detectClaudeAccount().then((s) => setClaudeStatus(s))
    void detectCodexAccount().then((s) => setCodexStatus(s))
    void detectCopilotAccount().then((s) => setCopilotStatus(s))
  }, [section])

  function bodyRows(): SettingsRow[] {
    return sectionRows(section, {
      themeNames,
      focusAccentSlots: FOCUS_ACCENT_SLOTS,
      engineList: engines.engineList(),
      hasDaemon,
    })
  }

  function bodyRowCount(): number {
    return bodyRows().length
  }

  function selectTheme(name: string): void {
    if (themeCtx.selected === name) return
    if (!themeCtx.set(name)) return
    props.kv.set("activeTheme", name)
    props.onVisualPrefsChange?.()
  }

  function selectLanguage(locale: LocaleId): void {
    if (currentLang() === locale) return
    setLocaleLang(locale)
    props.kv.set(LOCALE_KEY, locale)
    props.onVisualPrefsChange?.()
  }

  function toggleTransparent(): void {
    const next = !themeCtx.transparentBackground
    themeCtx.setTransparentBackground(next)
    props.kv.set("transparentBackground", next)
    props.onVisualPrefsChange?.()
  }

  function selectFocusAccent(slot: FocusAccentSlot): void {
    if (themeCtx.focusAccent === slot) return
    themeCtx.setFocusAccent(slot)
    props.kv.set("focusAccent", slot)
    props.onVisualPrefsChange?.()
  }

  function currentEngineRow(): VendorId | null {
    if (section !== "engines" || level !== "body") return null
    const row = rowAt(bodyRows(), bodyRow)
    return row?.kind === "engine" ? row.vendor : null
  }

  async function sendFeedback(): Promise<void> {
    setFeedbackStatus("submitting...")
    try {
      const result = submitFeedback({ title: feedbackTitle, body: feedbackBody })
      setFeedbackStatus(`sent: ${result.url}`)
      setFeedbackTitle("")
      setFeedbackBody("")
      setBodyRow(0)
    } catch (err) {
      setFeedbackStatus(`error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const editingFeedback = section === "feedback" && level === "body"

  function feedbackFieldStep(delta: 1 | -1): void {
    const next = bodyRow + delta
    if (next < 0 || next > 2) {
      setLevel("sidebar")
      return
    }
    setBodyRow(next)
  }

  function enterBody(): void {
    if (level !== "sidebar" || bodyRowCount() === 0) return
    setLevel("body")
    setBodyRow(0)
  }

  function moveCursor(delta: number): void {
    if (level === "sidebar") {
      const next = (cursor + delta + SECTIONS.length) % SECTIONS.length
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
    setBodyRow((bodyRow + delta + len) % len)
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
    toast: () => prefs.toggleToast(),
    sound: () => prefs.toggleSound(),
    zenKeepTasks: () => prefs.toggleZenKeepsTasks(),
    surface: (row) => prefs.selectSurface(row.surface),
    editorKind: () => prefs.cycleEditorKind(),
    editorCustom: () => void prefs.editEditorCustom(),
    worktreeBase: () => prefs.cycleWorktreeBase(),
    worktreeCustom: () => void prefs.editWorktreeCustom(),
    engine: (row) => void engines.editEngine(row.vendor),
    engineAdd: () => void engines.addEngineFlow(),
    feedbackTitle: () => setBodyRow(0),
    feedbackBody: () => setBodyRow(1),
    feedbackSend: () => void sendFeedback(),
    devReset: () => void confirmResetState(dialog, props.kv, renderer),
    devRestartDaemon: () => void confirmRestartDaemon(dialog, props.orchestrator, renderer),
    devRemoteProjects: () => prefs.toggleRemoteProjects(),
    devAutoStatus: () => prefs.toggleAutoStatus(),
    devDispatcher: () => prefs.toggleDispatcher(),
    devArchivedHistory: () => prefs.toggleArchivedHistory(),
  }

  function activateBodyRow(): void {
    const row = rowAt(bodyRows(), bodyRow)
    if (!row) return
    ;(rowActivators[row.kind] as (row: SettingsRow) => void)(row)
  }

  useBindings(() => ({
    enabled: (!props.standalone || dialog.stack.length === 0) && !editingFeedback,
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
          if (level === "sidebar") {
            enterBody()
            return
          }
          activateBodyRow()
        },
      },
      { key: "t", cmd: toggleTransparent },
      {
        key: "r",
        cmd: () => {
          const v = currentEngineRow()
          if (v) void engines.renameEngine(v)
        },
      },
      {
        key: "x",
        cmd: () => {
          const v = currentEngineRow()
          if (v) engines.resetEngine(v)
        },
      },
      {
        key: "d",
        cmd: () => {
          const v = currentEngineRow()
          if (v) engines.setEngineDefault(v)
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: editingFeedback,
    bindings: [
      { key: "tab", cmd: () => feedbackFieldStep(1) },
      { key: "shift+tab", cmd: () => feedbackFieldStep(-1) },
    ],
  }))
  useBindings(() => ({
    enabled: editingFeedback && bodyRow === 2,
    bindings: [{ key: "return", cmd: () => void sendFeedback() }],
  }))

  const cursorProps = { level, bodyRow, setLevel, setBodyRow }
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
          {section === "general" ? (
            <GeneralSettingsSection
              {...cursorProps}
              themeNames={themeNames}
              selectTheme={selectTheme}
              currentLocale={currentLang()}
              selectLanguage={selectLanguage}
              toggleTransparent={toggleTransparent}
              selectFocusAccent={selectFocusAccent}
              toastEnabled={prefs.toastEnabled()}
              soundEnabled={prefs.soundEnabled()}
              toggleToast={prefs.toggleToast}
              toggleSound={prefs.toggleSound}
              zenKeepsTasks={prefs.zenKeepsTasks()}
              toggleZenKeepsTasks={prefs.toggleZenKeepsTasks}
              settingsSurface={prefs.settingsSurface()}
              selectSurface={prefs.selectSurface}
              editorKind={prefs.editorKind()}
              cycleEditorKind={prefs.cycleEditorKind}
              editorCustomCommand={prefs.editorCustomCommand()}
              editEditorCustom={() => void prefs.editEditorCustom()}
              worktreeKind={prefs.worktreeKind()}
              worktreeKindLabel={prefs.worktreeKindLabel()}
              cycleWorktreeBase={prefs.cycleWorktreeBase}
              worktreeCustomPath={prefs.worktreeCustomPath()}
              editWorktreeCustom={() => void prefs.editWorktreeCustom()}
            />
          ) : null}
          {section === "engines" ? (
            <EngineSettingsSection
              {...cursorProps}
              vendors={engines.engineList()}
              isCustom={(v) => !isBuiltinVendor(v)}
              displayName={engines.engineName}
              commandText={engines.engineCommandText}
              isDefault={engines.engineIsDefault}
              isDefaultEngine={(v) => engines.defaultEngine === v}
              editEngine={(v) => void engines.editEngine(v)}
              onAddEngine={() => void engines.addEngineFlow()}
            />
          ) : null}
          {section === "accounts" ? (
            <AccountsSettingsSection
              claudeStatus={claudeStatus}
              codexStatus={codexStatus}
              copilotStatus={copilotStatus}
            />
          ) : null}
          {section === "keys" ? <KeybindingsSettingsSection /> : null}
          {section === "feedback" ? (
            <FeedbackSettingsSection
              {...cursorProps}
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
          ) : null}
          {section === "dev" ? (
            <DevSettingsSection
              {...cursorProps}
              hasDaemon={hasDaemon}
              confirmReset={() => void confirmResetState(dialog, props.kv, renderer)}
              confirmRestartDaemon={() => void confirmRestartDaemon(dialog, props.orchestrator, renderer)}
              remoteProjectsEnabled={prefs.remoteProjectsEnabled()}
              toggleRemoteProjects={prefs.toggleRemoteProjects}
              autoStatusEnabled={prefs.autoStatusOn()}
              toggleAutoStatus={prefs.toggleAutoStatus}
              dispatcherEnabled={prefs.dispatcherOn()}
              toggleDispatcher={prefs.toggleDispatcher}
              archivedHistoryEnabled={prefs.archivedHistoryOn()}
              toggleArchivedHistory={prefs.toggleArchivedHistory}
            />
          ) : null}
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>{editingFeedback ? t("settings.nav.feedback") : t("settings.nav.default")}</text>
      </box>
    </box>
  )
}
