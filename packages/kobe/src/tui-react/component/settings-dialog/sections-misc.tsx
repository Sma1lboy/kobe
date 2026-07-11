/** @jsxImportSource @opentui/react */
/**
 * Settings sections (React, issue #15 G3) — Feedback + Dev + Keybindings.
 * Port of the corresponding views in `src/tui/component/settings-dialog/
 * sections.tsx` (see that file for the feedback-form design notes: the
 * body is an UNCONTROLLED `<textarea>` so pasted newlines survive; edits
 * mirror back through `onContentChange`, and an external reset clears the
 * edit buffer through the ref).
 */

import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useEffect, useRef } from "react"
import { stripNewlines } from "../../../tui/component/new-task-dialog/state"
import { devRows, rowIndex } from "../../../tui/component/settings-dialog/model"
import { userKeybindingsReport } from "../../../tui/context/keybindings-user"
import { currentPrefixConfiguration } from "../../../tui/lib/keymap-dispatch"
import { FIXED_BINDING_IDS } from "../../../tui/lib/keymap-overrides"
import { useKeymapVersion } from "../../context/keybindings"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { Row, type SectionCursorProps, SubSection } from "./rows"

export function FeedbackSettingsSection(
  props: SectionCursorProps & {
    title: string
    setTitle: (v: string) => void
    body: string
    setBody: (v: string) => void
    status: string
    onTitleSubmit: () => void
    submit: () => void
  },
) {
  const { theme } = useTheme()
  const t = useT()
  const editing = props.level === "body"
  const titleFocused = editing && props.bodyRow === 0
  const bodyFocused = editing && props.bodyRow === 1
  const sendFocused = editing && props.bodyRow === 2
  const labelFg = (focused: boolean) => (focused ? theme.primary : theme.textMuted)
  const labelAttrs = (focused: boolean) => (focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined)

  // The body is an uncontrolled <textarea>, so an external reset (the
  // parent clears `feedbackBody` after a successful send) won't empty the
  // widget on its own. Clear the edit buffer when the value goes blank
  // while the widget still holds text; the resulting onContentChange sets
  // the value to "" too, so the guard makes this a one-shot (no loop).
  const bodyEl = useRef<TextareaRenderable | null>(null)
  useEffect(() => {
    if (props.body === "" && bodyEl.current && bodyEl.current.plainText !== "") {
      bodyEl.current.setText("")
    }
  }, [props.body])

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
          <text fg={labelFg(titleFocused)} attributes={labelAttrs(titleFocused)}>
            {t("settings.feedback.titleLabel")}
          </text>
          <input
            value={props.title}
            placeholder={t("settings.feedback.titlePlaceholder")}
            focused={titleFocused}
            onMouseUp={() => {
              props.setLevel("body")
              props.setBodyRow(0)
            }}
            onInput={(v: string) => props.setTitle(stripNewlines(v))}
            onSubmit={() => props.onTitleSubmit()}
          />
        </box>
        <box gap={0}>
          <text fg={labelFg(bodyFocused)} attributes={labelAttrs(bodyFocused)}>
            {t("settings.feedback.descriptionLabel")}
          </text>
          <textarea
            ref={(el: TextareaRenderable | null) => {
              bodyEl.current = el
            }}
            initialValue={props.body}
            placeholder={t("settings.feedback.descriptionPlaceholder")}
            focused={bodyFocused}
            height={4}
            wrapMode="word"
            onMouseUp={() => {
              props.setLevel("body")
              props.setBodyRow(1)
            }}
            onContentChange={() => props.setBody(bodyEl.current?.plainText ?? "")}
          />
        </box>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={sendFocused ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(2)
            props.submit()
          }}
        >
          <text fg={sendFocused ? theme.selectedListItemText : theme.accent} attributes={TextAttributes.BOLD}>
            {t("settings.feedback.send")}
          </text>
        </box>
      </box>
      {props.status ? (
        <text fg={props.status.startsWith("error:") ? theme.warning : theme.success} wrapMode="word">
          {props.status}
        </text>
      ) : null}
    </box>
  )
}

export function DevSettingsSection(
  props: SectionCursorProps & {
    hasDaemon: boolean
    confirmReset: () => void
    confirmRestartDaemon: () => void
    remoteProjectsEnabled: boolean
    toggleRemoteProjects: () => void
    autoStatusEnabled: boolean
    toggleAutoStatus: () => void
    dispatcherEnabled: boolean
    toggleDispatcher: () => void
    archivedHistoryEnabled: boolean
    toggleArchivedHistory: () => void
  },
) {
  const { theme } = useTheme()
  const t = useT()
  const rows = devRows(props.hasDaemon)
  const isBodyCursor = (row: number) => props.level === "body" && props.bodyRow === row
  const activate = (row: number, action: () => void) => () => {
    props.setLevel("body")
    props.setBodyRow(row)
    action()
  }
  const toggleRow = (id: string, enabled: boolean, hintKey: string, onKey: string, offKey: string, act: () => void) => {
    const row = rowIndex(rows, id)
    return (
      <>
        <text fg={theme.textMuted} wrapMode="word">
          {t(hintKey)}
        </text>
        <Row
          cursor={isBodyCursor(row)}
          onMouseUp={activate(row, act)}
          fg={theme.text}
          bold={enabled}
          idleBackground={theme.backgroundElement}
        >
          {enabled ? t(onKey) : t(offKey)}
        </Row>
      </>
    )
  }
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.dev.reset")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.dev.resetHint")}
      </text>
      <Row
        cursor={isBodyCursor(0)}
        onMouseUp={activate(0, props.confirmReset)}
        fg={theme.warning}
        bold={true}
        idleBackground={theme.backgroundElement}
      >
        {t("settings.dev.resetButton")}
      </Row>
      {props.hasDaemon ? (
        <SubSection title={t("settings.dev.restart")} hint={t("settings.dev.restartHint")}>
          <Row
            cursor={isBodyCursor(1)}
            onMouseUp={activate(1, props.confirmRestartDaemon)}
            fg={theme.accent}
            bold={true}
            idleBackground={theme.backgroundElement}
          >
            {t("settings.dev.restartButton")}
          </Row>
        </SubSection>
      ) : null}
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.dev.doctorHint")}
      </text>

      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("settings.dev.experimental")}
        </text>
        {toggleRow(
          "remote-projects",
          props.remoteProjectsEnabled,
          "settings.dev.remoteHint",
          "settings.dev.remoteOn",
          "settings.dev.remoteOff",
          props.toggleRemoteProjects,
        )}
        {toggleRow(
          "auto-status",
          props.autoStatusEnabled,
          "settings.dev.autoStatusHint",
          "settings.dev.autoStatusOn",
          "settings.dev.autoStatusOff",
          props.toggleAutoStatus,
        )}
        {toggleRow(
          "dispatcher",
          props.dispatcherEnabled,
          "settings.dev.dispatcherHint",
          "settings.dev.dispatcherOn",
          "settings.dev.dispatcherOff",
          props.toggleDispatcher,
        )}
        {toggleRow(
          "archived-history",
          props.archivedHistoryEnabled,
          "settings.dev.archivedHistoryHint",
          "settings.dev.archivedHistoryOn",
          "settings.dev.archivedHistoryOff",
          props.toggleArchivedHistory,
        )}
      </box>
    </box>
  )
}

/**
 * Keybindings section — read-only view of the user keybinding overrides
 * loaded at boot from `~/.kobe/settings/keybindings.yaml`. Editing happens
 * in the YAML file, not here; the section's job is to make the config
 * discoverable, show which overrides actually landed, and surface every
 * load warning that otherwise only reaches the pane's console log.
 */
export function KeybindingsSettingsSection() {
  const { theme } = useTheme()
  const t = useT()
  // Re-read the cached report when the daemon's keybindings channel triggers
  // the host's live keymap reload, so an already-open Settings page stays
  // truthful after a YAML edit.
  useKeymapVersion()
  const report = userKeybindingsReport()
  const prefix = currentPrefixConfiguration()
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
          {report.path + (report.exists ? "" : t("settings.keybindings.notCreated"))}
        </text>
      </box>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          PureTUI prefix
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {`First stroke: ${prefix.key ?? "disabled"}; timeout: ${prefix.timeoutMs}ms. Prefix bindings retain their existing pane scope and modal barrier.`}
        </text>
      </box>
      {!report.exists ? (
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.example")}
          </text>
          <text fg={theme.textMuted}>prefix:</text>
          <text fg={theme.textMuted}>{"  key: ctrl+a                 # first stroke (null disables)"}</text>
          <text fg={theme.textMuted}>{"  timeoutMs: 1000             # second stroke deadline"}</text>
          <text fg={theme.textMuted}>{"  bindings:"}</text>
          <text fg={theme.textMuted}>{"    chat.tab.new: t           # ctrl+a, then t"}</text>
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
      ) : (
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.overridesApplied")}
          </text>
          {report.applied.length === 0 ? <text fg={theme.textMuted}>{t("settings.keybindings.none")}</text> : null}
          {report.applied.map((o) => (
            <text key={o.id} fg={theme.text} wrapMode="word">
              {`${o.id} → ${o.keys.length > 0 ? o.keys.join(" / ") : "(unbound)"}  (default: ${o.defaultKeys.join(" / ")})`}
            </text>
          ))}
        </box>
      )}
      {report.warnings.length > 0 ? (
        <box flexDirection="column" gap={0}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            {t("settings.keybindings.warnings")}
          </text>
          {report.warnings.map((w) => (
            <text key={w} fg={theme.warning} wrapMode="word">
              {`! ${w}`}
            </text>
          ))}
        </box>
      ) : null}
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
