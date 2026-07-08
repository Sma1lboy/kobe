/** @jsxImportSource @opentui/react */
/**
 * Settings sections (React, issue #15 G3) — sidebar + General. Port of the
 * corresponding views in `src/tui/component/settings-dialog/sections.tsx`;
 * row indices come from the shared framework-free row registry (`model.ts`),
 * so keyboard navigation and click targets stay in lockstep with the Solid
 * dialog. Accessor props became plain values/callbacks (React re-renders
 * through the provider on every kv/theme change).
 */

import { TextAttributes } from "@opentui/core"
import { useMemo } from "react"
import { SPLIT_STYLES, type SplitStyle } from "../../../state/split-style"
import type { WorktreeBaseKind } from "../../../state/worktree-base"
import {
  type NavLevel,
  SECTIONS,
  type SectionId,
  focusAccentRowId,
  generalRows,
  languageRowId,
  rowIndex,
  splitStyleRowId,
  surfaceRowId,
} from "../../../tui/component/settings-dialog/model"
import { LOCALES, type LocaleId } from "../../../tui/i18n/catalog"
import type { EditorKind } from "../../../tui/lib/editor-prefs"
import type { SettingsSurface } from "../../../tui/lib/settings-surface"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { Row, type SectionCursorProps, SubSection } from "./rows"

export function SettingsSectionSidebar(props: {
  level: NavLevel
  cursor: number
  switchSection: (id: SectionId) => void
}) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <box flexDirection="column" flexShrink={0} width={14} gap={1}>
      {SECTIONS.map((s, i) => {
        const isSection = i === props.cursor
        const isSidebarFocused = isSection && props.level === "sidebar"
        return (
          <box
            key={s.id}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isSidebarFocused ? theme.primary : undefined}
            onMouseUp={() => props.switchSection(s.id)}
          >
            <text
              fg={isSidebarFocused ? theme.selectedListItemText : isSection ? theme.accent : theme.textMuted}
              attributes={isSection ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {t(`settings.sections.${s.id}`)}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export function GeneralSettingsSection(
  props: SectionCursorProps & {
    themeNames: readonly string[]
    selectTheme: (name: string) => void
    currentLocale: LocaleId
    selectLanguage: (locale: LocaleId) => void
    toggleTransparent: () => void
    toggleReducedMotion: () => void
    selectFocusAccent: (slot: FocusAccentSlot) => void
    toastEnabled: boolean
    soundEnabled: boolean
    toggleToast: () => void
    toggleSound: () => void
    splitStyle: SplitStyle
    selectSplitStyle: (style: SplitStyle) => void
    zenKeepsTasks: boolean
    toggleZenKeepsTasks: () => void
    settingsSurface: SettingsSurface
    selectSurface: (surface: SettingsSurface) => void
    editorKind: EditorKind
    cycleEditorKind: () => void
    editorCustomCommand: string
    editEditorCustom: () => void
    worktreeKind: WorktreeBaseKind
    worktreeKindLabel: string
    cycleWorktreeBase: () => void
    worktreeCustomPath: string
    editWorktreeCustom: () => void
  },
) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const t = useT()
  // Row registry for this section — a row's body index is its position in
  // the list, so every index below is an id lookup, not arithmetic.
  const rows = useMemo(
    () => generalRows({ themeNames: props.themeNames, focusAccentSlots: FOCUS_ACCENT_SLOTS }),
    [props.themeNames],
  )
  const rowIdx = (id: string) => rowIndex(rows, id)
  const isBodyCursor = (row: number) => props.level === "body" && props.bodyRow === row
  const activate = (row: number, action: () => void) => () => {
    props.setLevel("body")
    props.setBodyRow(row)
    action()
  }
  const onOff = (on: boolean) => (on ? t("settings.general.on") : t("settings.general.off"))
  const check = (on: boolean) => (on ? "[x]" : "[ ]")

  const transparentRow = rowIdx("transparent")
  const reducedMotionRow = rowIdx("reduced-motion")
  const toastRow = rowIdx("toast")
  const soundRow = rowIdx("sound")
  const zenKeepTasksRow = rowIdx("zen-keep-tasks")
  const surfaceChattabRow = rowIdx(surfaceRowId("chattab"))
  const surfaceTaskpanelRow = rowIdx(surfaceRowId("taskpanel"))
  const editorKindRow = rowIdx("editor-kind")
  const editorCustomRow = rowIdx("editor-custom")
  const worktreeBaseRow = rowIdx("worktree-base")
  const worktreeCustomRow = rowIdx("worktree-custom")

  return (
    <box flexDirection="column" gap={1}>
      {/* First block matches the Solid layout: title/hint/rows are direct
          children of the outer gap-1 box (one blank line between each). */}
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.general.theme")}
      </text>
      <text fg={theme.textMuted}>{t("settings.general.themeHint")}</text>
      <box flexDirection="column" gap={0}>
        {props.themeNames.map((name, i) => {
          const isSelected = name === themeCtx.selected
          return (
            <Row
              key={name}
              cursor={isBodyCursor(i)}
              onMouseUp={activate(i, () => props.selectTheme(name))}
              fg={isSelected ? theme.accent : theme.text}
              bold={isBodyCursor(i) || isSelected}
            >
              {`${isSelected ? "● " : "  "}${name}`}
            </Row>
          )
        })}
      </box>
      <SubSection title={t("settings.general.language")} hint={t("settings.general.languageHint")}>
        {LOCALES.map((loc) => {
          const langRow = rowIdx(languageRowId(loc.id))
          const isSelected = props.currentLocale === loc.id
          return (
            <Row
              key={loc.id}
              cursor={isBodyCursor(langRow)}
              onMouseUp={activate(langRow, () => props.selectLanguage(loc.id))}
              fg={isSelected ? theme.accent : theme.text}
              bold={isBodyCursor(langRow) || isSelected}
            >
              {`${isSelected ? "● " : "  "}${loc.label}`}
            </Row>
          )
        })}
      </SubSection>
      <SubSection title={t("settings.general.transparent")} hint={t("settings.general.transparentHint")}>
        <Row
          cursor={isBodyCursor(transparentRow)}
          onMouseUp={activate(transparentRow, props.toggleTransparent)}
          fg={themeCtx.transparentBackground ? theme.accent : theme.textMuted}
          bold={true}
        >
          {onOff(themeCtx.transparentBackground)}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.focusAccent")} hint={t("settings.general.focusAccentHint")}>
        {FOCUS_ACCENT_SLOTS.map((slot) => {
          const accentRow = rowIdx(focusAccentRowId(slot))
          const isSelected = themeCtx.focusAccent === slot
          return (
            <Row
              key={slot}
              cursor={isBodyCursor(accentRow)}
              onMouseUp={activate(accentRow, () => props.selectFocusAccent(slot))}
              fg={isSelected ? theme.focusAccent : theme.text}
              bold={isBodyCursor(accentRow) || isSelected}
            >
              {`${isSelected ? "● " : "  "}${t(`settings.general.accent${slot.charAt(0).toUpperCase()}${slot.slice(1)}`)}`}
            </Row>
          )
        })}
      </SubSection>
      <SubSection title={t("settings.general.reducedMotion")} hint={t("settings.general.reducedMotionHint")}>
        <Row
          cursor={isBodyCursor(reducedMotionRow)}
          onMouseUp={activate(reducedMotionRow, props.toggleReducedMotion)}
          fg={themeCtx.reducedMotion ? theme.accent : theme.textMuted}
          bold={true}
        >
          {onOff(themeCtx.reducedMotion)}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.appearance")} hint={t("settings.general.appearanceHint")}>
        {SPLIT_STYLES.map((style) => {
          const styleRow = rowIdx(splitStyleRowId(style))
          const isSelected = props.splitStyle === style
          return (
            <Row
              key={style}
              cursor={isBodyCursor(styleRow)}
              onMouseUp={activate(styleRow, () => props.selectSplitStyle(style))}
              fg={isSelected ? theme.accent : theme.text}
              bold={isBodyCursor(styleRow) || isSelected}
            >
              {`${isSelected ? "● " : "  "}${t(style === "box" ? "settings.general.splitBox" : "settings.general.splitLine")}`}
            </Row>
          )
        })}
      </SubSection>
      <SubSection title={t("settings.general.notifications")} hint={t("settings.general.notificationsHint")}>
        <Row
          cursor={isBodyCursor(toastRow)}
          onMouseUp={activate(toastRow, props.toggleToast)}
          fg={props.toastEnabled ? theme.accent : theme.textMuted}
          bold={true}
        >
          {`${check(props.toastEnabled)} ${t("settings.general.toast")}`}
        </Row>
        <Row
          cursor={isBodyCursor(soundRow)}
          onMouseUp={activate(soundRow, props.toggleSound)}
          fg={props.soundEnabled ? theme.accent : theme.textMuted}
          bold={true}
        >
          {`${check(props.soundEnabled)} ${t("settings.general.sound")}`}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.zen")} hint={t("settings.general.zenHint")}>
        <Row
          cursor={isBodyCursor(zenKeepTasksRow)}
          onMouseUp={activate(zenKeepTasksRow, props.toggleZenKeepsTasks)}
          fg={props.zenKeepsTasks ? theme.accent : theme.textMuted}
          bold={true}
        >
          {`${check(props.zenKeepsTasks)} ${t("settings.general.zenKeepTasks")}`}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.surface")} hint={t("settings.general.surfaceHint")}>
        <Row
          cursor={isBodyCursor(surfaceChattabRow)}
          onMouseUp={activate(surfaceChattabRow, () => props.selectSurface("chattab"))}
          fg={props.settingsSurface === "chattab" ? theme.accent : theme.textMuted}
          bold={true}
        >
          {`${check(props.settingsSurface === "chattab")} ${t("settings.general.surfaceChattab")}`}
        </Row>
        <Row
          cursor={isBodyCursor(surfaceTaskpanelRow)}
          onMouseUp={activate(surfaceTaskpanelRow, () => props.selectSurface("taskpanel"))}
          fg={props.settingsSurface === "taskpanel" ? theme.accent : theme.textMuted}
          bold={true}
        >
          {`${check(props.settingsSurface === "taskpanel")} ${t("settings.general.surfaceTaskpanel")}`}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.editor")} hint={t("settings.general.editorHint")}>
        <Row
          cursor={isBodyCursor(editorKindRow)}
          onMouseUp={activate(editorKindRow, props.cycleEditorKind)}
          fg={theme.accent}
          bold={true}
        >
          {t("settings.general.editorRow", { kind: props.editorKind })}
        </Row>
        <Row
          cursor={isBodyCursor(editorCustomRow)}
          onMouseUp={activate(editorCustomRow, props.editEditorCustom)}
          fg={props.editorKind === "custom" ? theme.text : theme.textMuted}
        >
          {t("settings.general.editorCustom", {
            cmd: props.editorCustomCommand.trim() || t("settings.general.editorCustomUnset"),
          })}
        </Row>
      </SubSection>
      <SubSection title={t("settings.general.worktree")} hint={t("settings.general.worktreeHint")}>
        <Row
          cursor={isBodyCursor(worktreeBaseRow)}
          onMouseUp={activate(worktreeBaseRow, props.cycleWorktreeBase)}
          fg={theme.accent}
          bold={true}
        >
          {t("settings.general.worktreeBase", { kind: props.worktreeKindLabel })}
        </Row>
        <Row
          cursor={isBodyCursor(worktreeCustomRow)}
          onMouseUp={activate(worktreeCustomRow, props.editWorktreeCustom)}
          fg={props.worktreeKind === "custom" ? theme.text : theme.textMuted}
        >
          {t("settings.general.worktreeCustom", {
            path: props.worktreeCustomPath || t("settings.general.worktreeCustomUnset"),
          })}
        </Row>
      </SubSection>
    </box>
  )
}
