import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { type Accessor, For, type Setter, Show, createEffect } from "solid-js"
import type { ClaudeAccount, CodexAccount, CopilotAccount, EngineAccountStatus } from "../../../engine/account-detect"
import type { WorktreeBaseKind } from "../../../state/worktree-base"
import type { VendorId } from "../../../types/task"
import { userKeybindingsReport } from "../../context/keybindings-user"
import { FOCUS_ACCENT_SLOTS, useTheme } from "../../context/theme"
import { t } from "../../i18n"
import { LOCALES, type LocaleId } from "../../i18n/catalog"
import type { EditorKind } from "../../lib/editor-prefs"
import { FIXED_BINDING_IDS } from "../../lib/keymap-overrides"
import type { SettingsSurface } from "../../lib/settings-surface"
import { stripNewlines } from "../new-task-dialog"
import {
  type NavLevel,
  SECTIONS,
  type SectionId,
  devRows,
  focusAccentRowId,
  generalRows,
  languageRowId,
  rowIndex,
  surfaceRowId,
} from "./model"

type CursorSetters = {
  setLevel: Setter<NavLevel>
  setBodyRow: Setter<number>
}

export function SettingsSectionSidebar(props: {
  level: Accessor<NavLevel>
  cursor: Accessor<number>
  switchSection: (id: SectionId) => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0} width={14} gap={1}>
      <For each={SECTIONS}>
        {(s, i) => {
          const isSection = () => i() === props.cursor()
          const isSidebarFocused = () => isSection() && props.level() === "sidebar"
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isSidebarFocused() ? theme.primary : undefined}
              onMouseUp={() => props.switchSection(s.id)}
            >
              <text
                fg={isSidebarFocused() ? theme.selectedListItemText : isSection() ? theme.accent : theme.textMuted}
                attributes={isSection() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {t(`settings.sections.${s.id}`)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function GeneralSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    themeNames: Accessor<readonly string[]>
    setThemeCursor: Setter<number>
    selectTheme: (name: string) => void
    currentLocale: Accessor<LocaleId>
    selectLanguage: (locale: LocaleId) => void
    toggleTransparent: () => void
    selectFocusAccent: (slot: (typeof FOCUS_ACCENT_SLOTS)[number]) => void
    toastEnabled: Accessor<boolean>
    soundEnabled: Accessor<boolean>
    toggleToast: () => void
    toggleSound: () => void
    zenKeepsTasks: Accessor<boolean>
    toggleZenKeepsTasks: () => void
    settingsSurface: Accessor<SettingsSurface>
    selectSurface: (surface: SettingsSurface) => void
    editorKind: Accessor<EditorKind>
    cycleEditorKind: () => void
    editorCustomCommand: Accessor<string>
    editEditorCustom: () => void
    worktreeKind: Accessor<WorktreeBaseKind>
    worktreeKindLabel: Accessor<string>
    cycleWorktreeBase: () => void
    worktreeCustomPath: Accessor<string>
    editWorktreeCustom: () => void
  },
) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  // Row registry for this section — a row's body index is its position
  // in the list, so every index below is an id lookup, not arithmetic.
  const rows = () => generalRows({ themeNames: props.themeNames(), focusAccentSlots: FOCUS_ACCENT_SLOTS })
  const rowIdx = (id: string) => rowIndex(rows(), id)
  const transparentRow = () => rowIdx("transparent")
  const toastRow = () => rowIdx("toast")
  const soundRow = () => rowIdx("sound")
  const zenKeepTasksRow = () => rowIdx("zen-keep-tasks")
  const surfaceChattabRow = () => rowIdx(surfaceRowId("chattab"))
  const surfaceTaskpanelRow = () => rowIdx(surfaceRowId("taskpanel"))
  const editorKindRow = () => rowIdx("editor-kind")
  const editorCustomRow = () => rowIdx("editor-custom")
  const worktreeBaseRow = () => rowIdx("worktree-base")
  const worktreeCustomRow = () => rowIdx("worktree-custom")
  const isTransparentRow = () => props.bodyRow() === transparentRow()
  const isToastRow = () => props.bodyRow() === toastRow()
  const isSoundRow = () => props.bodyRow() === soundRow()
  const isZenKeepTasksRow = () => props.bodyRow() === zenKeepTasksRow()
  const isSurfaceChattabRow = () => props.bodyRow() === surfaceChattabRow()
  const isSurfaceTaskpanelRow = () => props.bodyRow() === surfaceTaskpanelRow()
  const isEditorKindRow = () => props.bodyRow() === editorKindRow()
  const isEditorCustomRow = () => props.bodyRow() === editorCustomRow()
  const isWorktreeBaseRow = () => props.bodyRow() === worktreeBaseRow()
  const isWorktreeCustomRow = () => props.bodyRow() === worktreeCustomRow()

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.general.theme")}
      </text>
      <text fg={theme.textMuted}>{t("settings.general.themeHint")}</text>
      <box flexDirection="column" gap={0}>
        <For each={props.themeNames()}>
          {(name, i) => {
            const isCursor = () => props.level() === "body" && props.bodyRow() === i()
            const isSelected = () => name === themeCtx.selected
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isCursor() ? theme.primary : undefined}
                onMouseUp={() => {
                  props.setLevel("body")
                  props.setBodyRow(i())
                  props.setThemeCursor(i())
                  props.selectTheme(name)
                }}
              >
                <text
                  fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.accent : theme.text}
                  attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {isSelected() ? "● " : "  "}
                  {name}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.language")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.languageHint")}
        </text>
        <For each={LOCALES}>
          {(loc) => {
            const langRow = () => rowIdx(languageRowId(loc.id))
            const isCursor = () => props.level() === "body" && props.bodyRow() === langRow()
            const isSelected = () => props.currentLocale() === loc.id
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isCursor() ? theme.primary : undefined}
                onMouseUp={() => {
                  props.setLevel("body")
                  props.setBodyRow(langRow())
                  props.selectLanguage(loc.id)
                }}
              >
                <text
                  fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.accent : theme.text}
                  attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {isSelected() ? "● " : "  "}
                  {loc.label}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.transparent")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.transparentHint")}
        </text>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isTransparentRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(transparentRow())
            props.toggleTransparent()
          }}
        >
          <text
            fg={
              isTransparentRow()
                ? theme.selectedListItemText
                : themeCtx.transparentBackground
                  ? theme.accent
                  : theme.textMuted
            }
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {themeCtx.transparentBackground ? t("settings.general.on") : t("settings.general.off")}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.focusAccent")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.focusAccentHint")}
        </text>
        <For each={FOCUS_ACCENT_SLOTS}>
          {(slot) => {
            const accentRow = () => rowIdx(focusAccentRowId(slot))
            const isCursor = () => props.level() === "body" && props.bodyRow() === accentRow()
            const isSelected = () => themeCtx.focusAccent === slot
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isCursor() ? theme.primary : undefined}
                onMouseUp={() => {
                  props.setLevel("body")
                  props.setBodyRow(accentRow())
                  props.selectFocusAccent(slot)
                }}
              >
                <text
                  fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.focusAccent : theme.text}
                  attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {isSelected() ? "● " : "  "}
                  {t(`settings.general.accent${slot.charAt(0).toUpperCase()}${slot.slice(1)}`)}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.notifications")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.notificationsHint")}
        </text>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isToastRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(toastRow())
            props.toggleToast()
          }}
        >
          <text
            fg={isToastRow() ? theme.selectedListItemText : props.toastEnabled() ? theme.accent : theme.textMuted}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {props.toastEnabled() ? "[x]" : "[ ]"} {t("settings.general.toast")}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isSoundRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(soundRow())
            props.toggleSound()
          }}
        >
          <text
            fg={isSoundRow() ? theme.selectedListItemText : props.soundEnabled() ? theme.accent : theme.textMuted}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {props.soundEnabled() ? "[x]" : "[ ]"} {t("settings.general.sound")}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.zen")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.zenHint")}
        </text>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isZenKeepTasksRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(zenKeepTasksRow())
            props.toggleZenKeepsTasks()
          }}
        >
          <text
            fg={
              isZenKeepTasksRow() ? theme.selectedListItemText : props.zenKeepsTasks() ? theme.accent : theme.textMuted
            }
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {props.zenKeepsTasks() ? "[x]" : "[ ]"} {t("settings.general.zenKeepTasks")}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.surface")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.surfaceHint")}
        </text>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isSurfaceChattabRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(surfaceChattabRow())
            props.selectSurface("chattab")
          }}
        >
          <text
            fg={
              isSurfaceChattabRow()
                ? theme.selectedListItemText
                : props.settingsSurface() === "chattab"
                  ? theme.accent
                  : theme.textMuted
            }
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {props.settingsSurface() === "chattab" ? "[x]" : "[ ]"} {t("settings.general.surfaceChattab")}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isSurfaceTaskpanelRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(surfaceTaskpanelRow())
            props.selectSurface("taskpanel")
          }}
        >
          <text
            fg={
              isSurfaceTaskpanelRow()
                ? theme.selectedListItemText
                : props.settingsSurface() === "taskpanel"
                  ? theme.accent
                  : theme.textMuted
            }
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {props.settingsSurface() === "taskpanel" ? "[x]" : "[ ]"} {t("settings.general.surfaceTaskpanel")}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.editor")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.editorHint")}
        </text>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isEditorKindRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(editorKindRow())
            props.cycleEditorKind()
          }}
        >
          <text
            fg={isEditorKindRow() ? theme.selectedListItemText : theme.accent}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {t("settings.general.editorRow", { kind: props.editorKind() })}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isEditorCustomRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(editorCustomRow())
            props.editEditorCustom()
          }}
        >
          <text
            fg={
              isEditorCustomRow()
                ? theme.selectedListItemText
                : props.editorKind() === "custom"
                  ? theme.text
                  : theme.textMuted
            }
            wrapMode="none"
          >
            {t("settings.general.editorCustom", {
              cmd: props.editorCustomCommand().trim() || t("settings.general.editorCustomUnset"),
            })}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.general.worktree")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.general.worktreeHint")}
        </text>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isWorktreeBaseRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(worktreeBaseRow())
            props.cycleWorktreeBase()
          }}
        >
          <text
            fg={isWorktreeBaseRow() ? theme.selectedListItemText : theme.accent}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            {t("settings.general.worktreeBase", { kind: props.worktreeKindLabel() })}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isWorktreeCustomRow() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(worktreeCustomRow())
            props.editWorktreeCustom()
          }}
        >
          <text
            fg={
              isWorktreeCustomRow()
                ? theme.selectedListItemText
                : props.worktreeKind() === "custom"
                  ? theme.text
                  : theme.textMuted
            }
            wrapMode="none"
          >
            {t("settings.general.worktreeCustom", {
              path: props.worktreeCustomPath() || t("settings.general.worktreeCustomUnset"),
            })}
          </text>
        </box>
      </box>
    </box>
  )
}

export function EngineSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    vendors: readonly VendorId[]
    /** Display label for a vendor — custom name override, else VENDOR_LABEL. */
    displayName: (vendor: VendorId) => string
    /** Current launch command shown for a vendor (override or default). */
    commandText: (vendor: VendorId) => string
    /** Whether the engine is fully at its built-in default (dims it). */
    isDefault: (vendor: VendorId) => boolean
    /** Open the editor for a vendor's launch command (`enter`). */
    editEngine: (vendor: VendorId) => void
    /** Edit a vendor's custom display name (`r`). */
    renameEngine: (vendor: VendorId) => void
    /** Reset a built-in (or remove a custom) engine (`x`). */
    resetEngine: (vendor: VendorId) => void
    /** True for a user-added engine (shown with a `(custom)` tag; `x` removes it). */
    isCustom: (vendor: VendorId) => boolean
    /** True for the DEFAULT engine for new tasks (the ● marker; set with `d`). */
    isDefaultEngine: (vendor: VendorId) => boolean
    /** Register a new custom engine — the trailing "+ Add engine" row. */
    onAddEngine: () => void
  },
) {
  const { theme } = useTheme()
  // The "+ Add engine" row sits right after the last engine, at index = count.
  const addRowIndex = () => props.vendors.length
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.engines.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.engines.hint")}
      </text>
      <box flexDirection="column" gap={0}>
        <For each={props.vendors}>
          {(vendor, i) => {
            const isCursor = () => props.level() === "body" && props.bodyRow() === i()
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isCursor() ? theme.primary : undefined}
                onMouseUp={() => {
                  props.setLevel("body")
                  props.setBodyRow(i())
                  props.editEngine(vendor)
                }}
              >
                {/* ● marks the DEFAULT engine for new tasks (radio-style, like
                    the theme list); a space holds the column on the others. */}
                <text
                  fg={isCursor() ? theme.selectedListItemText : theme.accent}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                >
                  {props.isDefaultEngine(vendor) ? "●" : " "}
                </text>
                <text
                  fg={isCursor() ? theme.selectedListItemText : theme.text}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                >
                  {props.displayName(vendor)}
                </text>
                <text
                  fg={
                    isCursor() ? theme.selectedListItemText : props.isDefault(vendor) ? theme.textMuted : theme.accent
                  }
                  wrapMode="none"
                >
                  {props.commandText(vendor)}
                  {props.isDefault(vendor)
                    ? t("settings.engines.defaultTag")
                    : props.isCustom(vendor)
                      ? t("settings.engines.customTag")
                      : ""}
                </text>
              </box>
            )
          }}
        </For>
        {/* Trailing "+ Add engine" row. */}
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={props.level() === "body" && props.bodyRow() === addRowIndex() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(addRowIndex())
            props.onAddEngine()
          }}
        >
          <text
            fg={
              props.level() === "body" && props.bodyRow() === addRowIndex() ? theme.selectedListItemText : theme.primary
            }
            wrapMode="none"
          >
            {t("settings.engines.addEngine")}
          </text>
        </box>
      </box>
    </box>
  )
}

/** Read-only "is this engine installed + logged in" view. */
export function AccountsSettingsSection(props: {
  claudeStatus: Accessor<EngineAccountStatus<ClaudeAccount> | null>
  codexStatus: Accessor<EngineAccountStatus<CodexAccount> | null>
  copilotStatus: Accessor<EngineAccountStatus<CopilotAccount> | null>
}) {
  const { theme } = useTheme()
  const binaryLine = (s: EngineAccountStatus<unknown>) =>
    s.binary.found
      ? `Binary: ${(s.binary as { path: string }).path}`
      : `Binary: ${(s.binary as { error: string }).error}`
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.accounts.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.accounts.hint")}
      </text>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          claude-code
        </text>
        <Show when={props.claudeStatus() === null}>
          <text fg={theme.textMuted}>{t("settings.accounts.checking")}</text>
        </Show>
        <Show when={props.claudeStatus()}>
          {(s) => (
            <box flexDirection="column" gap={0}>
              <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                {binaryLine(s())}
              </text>
              {(() => {
                const a = s().account
                if (a.kind === "oauth") {
                  const tail = [a.organization, a.billingType].filter((x): x is string => !!x).join(" · ")
                  return (
                    <text fg={theme.success} wrapMode="word">
                      {t("settings.accounts.loggedIn", { email: a.email })}
                      {tail ? ` (${tail})` : ""}
                    </text>
                  )
                }
                return <text fg={theme.textMuted}>{t("settings.accounts.notLoggedIn")}</text>
              })()}
              <Show when={s().accountError}>
                {(err) => (
                  <text fg={theme.warning} wrapMode="word">
                    {`! ${err()}`}
                  </text>
                )}
              </Show>
            </box>
          )}
        </Show>
      </box>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          codex
        </text>
        <Show when={props.codexStatus() === null}>
          <text fg={theme.textMuted}>{t("settings.accounts.checking")}</text>
        </Show>
        <Show when={props.codexStatus()}>
          {(s) => (
            <box flexDirection="column" gap={0}>
              <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                {binaryLine(s())}
              </text>
              {(() => {
                const a = s().account
                if (a.kind === "chatgpt") {
                  return (
                    <text fg={theme.success} wrapMode="word">
                      {t("settings.accounts.chatgptLogin", { email: a.email })}
                      {a.plan ? ` (${a.plan})` : ""}
                    </text>
                  )
                }
                if (a.kind === "apikey")
                  return <text fg={theme.success}>{t("settings.accounts.apiKeyConfigured")}</text>
                return <text fg={theme.textMuted}>{t("settings.accounts.notLoggedIn")}</text>
              })()}
              <Show when={s().accountError}>
                {(err) => (
                  <text fg={theme.warning} wrapMode="word">
                    {`! ${err()}`}
                  </text>
                )}
              </Show>
            </box>
          )}
        </Show>
      </box>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          copilot
        </text>
        <Show when={props.copilotStatus() === null}>
          <text fg={theme.textMuted}>{t("settings.accounts.checking")}</text>
        </Show>
        <Show when={props.copilotStatus()}>
          {(s) => (
            <box flexDirection="column" gap={0}>
              <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                {binaryLine(s())}
              </text>
              {(() => {
                const a = s().account
                if (a.kind === "token")
                  return <text fg={theme.success}>{t("settings.accounts.tokenConfigured", { source: a.source })}</text>
                if (a.kind === "oauth") return <text fg={theme.success}>{t("settings.accounts.copilotDetected")}</text>
                return <text fg={theme.textMuted}>{t("settings.accounts.notLoggedIn")}</text>
              })()}
              <Show when={s().accountError}>
                {(err) => (
                  <text fg={theme.warning} wrapMode="word">
                    {`! ${err()}`}
                  </text>
                )}
              </Show>
            </box>
          )}
        </Show>
      </box>
    </box>
  )
}

/**
 * Feedback section — a conventional inline form, not a row list. Enter
 * (or l / click) from the sidebar focuses the `title` input; Tab walks
 * title → body → Send → back to the sidebar. Enter advances title → body;
 * the body is a multi-line `<textarea>`, so Enter there inserts a newline
 * (a bug report wants paragraphs), and the user Tabs to Send to commit.
 * The parent owns the Tab / Send-Enter bindings and suppresses its own
 * j/k/h/l nav while this form is focused so the inputs receive raw
 * keystrokes (the Send-row Enter binding is gated to bodyRow 2, so it
 * never steals the body textarea's Enter).
 *
 * The body uses `<textarea>` rather than `<input>` deliberately:
 * opentui's `<input>` (InputRenderable) strips newlines inside the native
 * widget on paste AND insert, so a multi-line pasted description was
 * silently collapsed to one line — pure data loss. `<textarea>` keeps the
 * newlines. It's an uncontrolled edit buffer (no reactive `value`/`onInput`
 * like `<input>`): we seed it once via `initialValue`, mirror edits back
 * into the signal through `onContentChange` (reading `plainText`), and
 * clear the buffer directly when the form resets after a send.
 */
export function FeedbackSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    title: Accessor<string>
    setTitle: (v: string) => void
    body: Accessor<string>
    setBody: (v: string) => void
    status: Accessor<string>
    onTitleSubmit: () => void
    submit: () => void
  },
) {
  const { theme } = useTheme()
  const editing = () => props.level() === "body"
  const titleFocused = () => editing() && props.bodyRow() === 0
  const bodyFocused = () => editing() && props.bodyRow() === 1
  const sendFocused = () => editing() && props.bodyRow() === 2
  const labelFg = (focused: boolean) => (focused ? theme.primary : theme.textMuted)
  const labelAttrs = (focused: boolean) => (focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined)

  // The body is an uncontrolled <textarea>, so an external reset (the
  // parent clears `feedbackBody` after a successful send) won't empty the
  // widget on its own. Clear the edit buffer when the signal goes blank
  // while the widget still holds text; the resulting onContentChange sets
  // the signal to "" too, so the guard makes this a one-shot (no loop).
  let bodyEl: TextareaRenderable | undefined
  createEffect(() => {
    if (props.body() === "" && bodyEl && bodyEl.plainText !== "") {
      bodyEl.setText("")
    }
  })
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.feedback.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.feedback.hint")}
      </text>
      <box flexDirection="column" gap={1}>
        <box gap={0}>
          <text fg={labelFg(titleFocused())} attributes={labelAttrs(titleFocused())}>
            {t("settings.feedback.titleLabel")}
          </text>
          <input
            value={props.title()}
            placeholder={t("settings.feedback.titlePlaceholder")}
            focused={titleFocused()}
            onMouseUp={() => {
              props.setLevel("body")
              props.setBodyRow(0)
            }}
            onInput={(v: string) => props.setTitle(stripNewlines(v))}
            onSubmit={() => props.onTitleSubmit()}
          />
        </box>
        <box gap={0}>
          <text fg={labelFg(bodyFocused())} attributes={labelAttrs(bodyFocused())}>
            {t("settings.feedback.descriptionLabel")}
          </text>
          <textarea
            ref={(el) => {
              bodyEl = el
            }}
            initialValue={props.body()}
            placeholder={t("settings.feedback.descriptionPlaceholder")}
            focused={bodyFocused()}
            height={4}
            wrapMode="word"
            onMouseUp={() => {
              props.setLevel("body")
              props.setBodyRow(1)
            }}
            onContentChange={() => props.setBody(bodyEl?.plainText ?? "")}
          />
        </box>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={sendFocused() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(2)
            props.submit()
          }}
        >
          <text fg={sendFocused() ? theme.selectedListItemText : theme.accent} attributes={TextAttributes.BOLD}>
            {t("settings.feedback.send")}
          </text>
        </box>
      </box>
      <Show when={props.status()}>
        <text fg={props.status().startsWith("error:") ? theme.warning : theme.success} wrapMode="word">
          {props.status()}
        </text>
      </Show>
    </box>
  )
}

export function DevSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    hasDaemon: boolean
    confirmReset: () => void
    confirmRestartDaemon: () => void
    remoteProjectsEnabled: Accessor<boolean>
    toggleRemoteProjects: () => void
    autoStatusEnabled: Accessor<boolean>
    toggleAutoStatus: () => void
    dispatcherEnabled: Accessor<boolean>
    toggleDispatcher: () => void
    archivedHistoryEnabled: Accessor<boolean>
    toggleArchivedHistory: () => void
  },
) {
  const { theme } = useTheme()
  const resetIsCursor = () => props.level() === "body" && props.bodyRow() === 0
  const restartIsCursor = () => props.level() === "body" && props.bodyRow() === 1
  const experimentalRow = () => rowIndex(devRows(props.hasDaemon), "remote-projects")
  const remoteIsCursor = () => props.level() === "body" && props.bodyRow() === experimentalRow()
  const autoStatusRow = () => rowIndex(devRows(props.hasDaemon), "auto-status")
  const autoStatusIsCursor = () => props.level() === "body" && props.bodyRow() === autoStatusRow()
  const dispatcherRow = () => rowIndex(devRows(props.hasDaemon), "dispatcher")
  const dispatcherIsCursor = () => props.level() === "body" && props.bodyRow() === dispatcherRow()
  const archivedHistoryRow = () => rowIndex(devRows(props.hasDaemon), "archived-history")
  const archivedHistoryIsCursor = () => props.level() === "body" && props.bodyRow() === archivedHistoryRow()
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.dev.reset")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.dev.resetHint")}
      </text>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={resetIsCursor() ? theme.primary : theme.backgroundElement}
        onMouseUp={() => {
          props.setLevel("body")
          props.setBodyRow(0)
          props.confirmReset()
        }}
      >
        <text fg={resetIsCursor() ? theme.selectedListItemText : theme.warning} attributes={TextAttributes.BOLD}>
          {t("settings.dev.resetButton")}
        </text>
      </box>
      <Show when={props.hasDaemon}>
        <box flexDirection="column" gap={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {t("settings.dev.restart")}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {t("settings.dev.restartHint")}
          </text>
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={restartIsCursor() ? theme.primary : theme.backgroundElement}
            onMouseUp={() => {
              props.setLevel("body")
              props.setBodyRow(1)
              props.confirmRestartDaemon()
            }}
          >
            <text fg={restartIsCursor() ? theme.selectedListItemText : theme.accent} attributes={TextAttributes.BOLD}>
              {t("settings.dev.restartButton")}
            </text>
          </box>
        </box>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.dev.doctorHint")}
      </text>

      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.dev.experimental")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.dev.remoteHint")}
        </text>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={remoteIsCursor() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(experimentalRow())
            props.toggleRemoteProjects()
          }}
        >
          <text
            fg={remoteIsCursor() ? theme.selectedListItemText : theme.text}
            attributes={props.remoteProjectsEnabled() ? TextAttributes.BOLD : undefined}
          >
            {props.remoteProjectsEnabled() ? t("settings.dev.remoteOn") : t("settings.dev.remoteOff")}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.dev.autoStatusHint")}
        </text>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={autoStatusIsCursor() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(autoStatusRow())
            props.toggleAutoStatus()
          }}
        >
          <text
            fg={autoStatusIsCursor() ? theme.selectedListItemText : theme.text}
            attributes={props.autoStatusEnabled() ? TextAttributes.BOLD : undefined}
          >
            {props.autoStatusEnabled() ? t("settings.dev.autoStatusOn") : t("settings.dev.autoStatusOff")}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.dev.dispatcherHint")}
        </text>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={dispatcherIsCursor() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(dispatcherRow())
            props.toggleDispatcher()
          }}
        >
          <text
            fg={dispatcherIsCursor() ? theme.selectedListItemText : theme.text}
            attributes={props.dispatcherEnabled() ? TextAttributes.BOLD : undefined}
          >
            {props.dispatcherEnabled() ? t("settings.dev.dispatcherOn") : t("settings.dev.dispatcherOff")}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.dev.archivedHistoryHint")}
        </text>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={archivedHistoryIsCursor() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(archivedHistoryRow())
            props.toggleArchivedHistory()
          }}
        >
          <text
            fg={archivedHistoryIsCursor() ? theme.selectedListItemText : theme.text}
            attributes={props.archivedHistoryEnabled() ? TextAttributes.BOLD : undefined}
          >
            {props.archivedHistoryEnabled()
              ? t("settings.dev.archivedHistoryOn")
              : t("settings.dev.archivedHistoryOff")}
          </text>
        </box>
      </box>
    </box>
  )
}

/**
 * Keybindings section — read-only view of the user keybinding overrides
 * loaded at boot from `~/.kobe/settings/keybindings.yaml` (see
 * `src/tui/context/keybindings-user.ts`). Editing happens in the YAML
 * file, not here; the section's job is to make the config discoverable,
 * show which overrides actually landed, and surface every load warning
 * that otherwise only reaches the pane's console log.
 */
export function KeybindingsSettingsSection() {
  const { theme } = useTheme()
  // Boot-time snapshot — overrides only change on restart, so a plain
  // (non-reactive) read is correct here.
  const report = userKeybindingsReport()
  const fixedIds = Object.keys(FIXED_BINDING_IDS).sort()
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.keybindings.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.keybindings.hint")}
      </text>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.keybindings.configFile")}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {report.path}
          {report.exists ? "" : t("settings.keybindings.notCreated")}
        </text>
      </box>
      <Show when={!report.exists}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.example")}
          </text>
          <text fg={theme.textMuted}>bindings:</text>
          <text fg={theme.textMuted}>{"  chat.fork.new: ctrl+g      # string = one chord"}</text>
          <text fg={theme.textMuted}>{"  sidebar.select: [enter]    # list = several chords"}</text>
          <text fg={theme.textMuted}>{"  files.createPR: null       # null = unbind"}</text>
          <text fg={theme.textMuted}>{"  tmux.tab.new: ctrl+y       # tmux session key (see below)"}</text>
          <text fg={theme.textMuted}>{"  tmux.layout.workspaceSplit: g  # prefix g"}</text>
          <text fg={theme.textMuted}>{"darwin:                      # platform overlay (also: linux)"}</text>
          <text fg={theme.textMuted}>{"  bindings:"}</text>
          <text fg={theme.textMuted}>{"    palette.open: [cmd+p, ctrl+p]"}</text>
        </box>
      </Show>
      <Show when={report.exists}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.overridesApplied")}
          </text>
          <Show when={report.applied.length === 0}>
            <text fg={theme.textMuted}>{t("settings.keybindings.none")}</text>
          </Show>
          <For each={report.applied}>
            {(o) => (
              <text fg={theme.text} wrapMode="word">
                {`${o.id} → ${o.keys.length > 0 ? o.keys.join(" / ") : "(unbound)"}  (default: ${o.defaultKeys.join(" / ")})`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={report.warnings.length > 0}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.warnings")}
          </text>
          <For each={report.warnings}>
            {(w) => (
              <text fg={theme.warning} wrapMode="word">
                {`! ${w}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        {
          "tmux session keys use the same file: tmux.tab.new (ctrl+t), tmux.tab.prev/next (ctrl+[/]), tmux.tab.close (ctrl+w), tmux.tab.rename (f2), tmux.tab.chooseEngine (ctrl+shift+t), tmux.detach (ctrl+q), tmux.focus (4 chords, left/down/up/right), and prefix layout keys: workspaceSplit (s), workspaceClose (x), workspaceReset (r), tasksToggle (a), opsToggle (o), terminalToggle (z). They apply when a session is (re)built."
        }
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {`Fixed (not rebindable): ${fixedIds.join(", ")}.`}
      </text>
    </box>
  )
}
