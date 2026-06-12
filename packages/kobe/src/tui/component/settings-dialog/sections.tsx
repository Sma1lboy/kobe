import { TextAttributes } from "@opentui/core"
import { type Accessor, For, type Setter, Show } from "solid-js"
import type { ClaudeAccount, CodexAccount, CopilotAccount, EngineAccountStatus } from "../../../engine/account-detect"
import type { VendorId } from "../../../types/task"
import { userKeybindingsReport } from "../../context/keybindings-user"
import { FOCUS_ACCENT_SLOTS, useTheme } from "../../context/theme"
import type { EditorKind } from "../../lib/editor-prefs"
import { FIXED_BINDING_IDS } from "../../lib/keymap-overrides"
import type { SettingsSurface } from "../../lib/settings-surface"
import {
  FOCUS_ACCENT_LABEL,
  type NavLevel,
  SECTIONS,
  type SectionId,
  devRows,
  focusAccentRowId,
  generalRows,
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
    <box flexDirection="column" flexShrink={0} width={14} gap={0}>
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
                {s.label}
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
    toggleTransparent: () => void
    selectFocusAccent: (slot: (typeof FOCUS_ACCENT_SLOTS)[number]) => void
    toastEnabled: Accessor<boolean>
    soundEnabled: Accessor<boolean>
    toggleToast: () => void
    toggleSound: () => void
    settingsSurface: Accessor<SettingsSurface>
    selectSurface: (surface: SettingsSurface) => void
    editorKind: Accessor<EditorKind>
    cycleEditorKind: () => void
    editorCustomCommand: Accessor<string>
    editEditorCustom: () => void
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
  const surfaceChattabRow = () => rowIdx(surfaceRowId("chattab"))
  const surfaceTaskpanelRow = () => rowIdx(surfaceRowId("taskpanel"))
  const editorKindRow = () => rowIdx("editor-kind")
  const editorCustomRow = () => rowIdx("editor-custom")
  const isTransparentRow = () => props.bodyRow() === transparentRow()
  const isToastRow = () => props.bodyRow() === toastRow()
  const isSoundRow = () => props.bodyRow() === soundRow()
  const isSurfaceChattabRow = () => props.bodyRow() === surfaceChattabRow()
  const isSurfaceTaskpanelRow = () => props.bodyRow() === surfaceTaskpanelRow()
  const isEditorKindRow = () => props.bodyRow() === editorKindRow()
  const isEditorCustomRow = () => props.bodyRow() === editorCustomRow()

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Theme
      </text>
      <text fg={theme.textMuted}>l to enter list · j/k to highlight · enter to apply</text>
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
          Transparent background
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Drops the renderer's bg fill so the host terminal shows through. `t` toggles.
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
            {themeCtx.transparentBackground ? "[x] on" : "[ ] off"}
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Focus accent
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Color of focused pane title, ▌ marker, and split borders.
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
                  {FOCUS_ACCENT_LABEL[slot]}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Notifications
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Fired when a background chat tab finishes or pauses on an approval. Toast = bottom-right popup; Sound =
          terminal bell + chime. Tab-chip unread dot is always on.
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
            {props.toastEnabled() ? "[x]" : "[ ]"} Toast
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
            {props.soundEnabled() ? "[x]" : "[ ]"} Sound
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Settings page
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Where Settings and the other full dialogs (new task, rename) open. ChatTab = a dedicated full-window page
          alongside the engine tabs; Task panel = an overlay inside the left Tasks pane. enter to pick.
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
            {props.settingsSurface() === "chattab" ? "[x]" : "[ ]"} ChatTab (separate page)
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
            {props.settingsSurface() === "taskpanel" ? "[x]" : "[ ]"} Task panel (in-pane overlay)
          </text>
        </box>
      </box>
      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Editor
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          What `e` opens a file with in the file tree (enter stays the read-only preview). `auto` (default) follows
          $VISUAL / $EDITOR, else auto-detects nvim / vim / emacs / nano. enter on the row below cycles auto / vim /
          nvim / nano / emacs / custom; if the editor isn't installed it falls back to the preview.
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
            {`editor: < ${props.editorKind()} >  (enter to change)`}
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
            {`custom: ${props.editorCustomCommand().trim() || "(unset — enter to edit)"}`}
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
        Launch command
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        The command each engine's task pane runs. Override a built-in when your binary isn't on PATH as `claude` /
        `codex` (e.g. it's `cl`) or to pass default flags, or add your own engine. ● = default engine for new tasks
        (also set by Ctrl+Shift+T). enter edit command · r rename · x reset/remove · d set default.
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
                  {props.isDefault(vendor) ? "  (default)" : props.isCustom(vendor) ? "  (custom)" : ""}
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
            + Add engine
          </text>
        </box>
      </box>
    </box>
  )
}

/** Read-only "is this engine installed + logged in" view (KOB-249). */
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
        Accounts
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Read-only view of locally-detected engine accounts. Login flows land here later.
      </text>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          claude-code
        </text>
        <Show when={props.claudeStatus() === null}>
          <text fg={theme.textMuted}>Checking…</text>
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
                      {`● Logged in: ${a.email}${tail ? ` (${tail})` : ""}`}
                    </text>
                  )
                }
                return <text fg={theme.textMuted}>○ Not logged in</text>
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
          <text fg={theme.textMuted}>Checking…</text>
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
                      {`● ChatGPT login: ${a.email}${a.plan ? ` (${a.plan})` : ""}`}
                    </text>
                  )
                }
                if (a.kind === "apikey") return <text fg={theme.success}>● API key configured</text>
                return <text fg={theme.textMuted}>○ Not logged in</text>
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
          <text fg={theme.textMuted}>Checking…</text>
        </Show>
        <Show when={props.copilotStatus()}>
          {(s) => (
            <box flexDirection="column" gap={0}>
              <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                {binaryLine(s())}
              </text>
              {(() => {
                const a = s().account
                if (a.kind === "token") return <text fg={theme.success}>{`● Token configured (${a.source})`}</text>
                if (a.kind === "oauth") return <text fg={theme.success}>● Copilot login detected</text>
                return <text fg={theme.textMuted}>○ Not logged in</text>
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

export function FeedbackSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    title: Accessor<string>
    body: Accessor<string>
    status: Accessor<string>
    editTitle: () => void
    editBody: () => void
    submit: () => void
  },
) {
  const { theme } = useTheme()
  const titleIsCursor = () => props.level() === "body" && props.bodyRow() === 0
  const bodyIsCursor = () => props.level() === "body" && props.bodyRow() === 1
  const submitIsCursor = () => props.level() === "body" && props.bodyRow() === 2
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Feedback
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Sends a GitHub Discussion to the kobe repo through `gh`. Requires `gh auth login`; category defaults to
        Feedback.
      </text>
      <box flexDirection="column" gap={0}>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={titleIsCursor() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(0)
            props.editTitle()
          }}
        >
          <text fg={titleIsCursor() ? theme.selectedListItemText : theme.text} attributes={TextAttributes.BOLD}>
            title
          </text>
          <text fg={titleIsCursor() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
            {props.title().trim() || "(enter to edit)"}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={bodyIsCursor() ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(1)
            props.editBody()
          }}
        >
          <text fg={bodyIsCursor() ? theme.selectedListItemText : theme.text} attributes={TextAttributes.BOLD}>
            body
          </text>
          <text fg={bodyIsCursor() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
            {props.body().trim() || "(enter to edit)"}
          </text>
        </box>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={submitIsCursor() ? theme.primary : theme.backgroundElement}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(2)
            props.submit()
          }}
        >
          <text fg={submitIsCursor() ? theme.selectedListItemText : theme.accent} attributes={TextAttributes.BOLD}>
            [enter] Send to GitHub Discussions
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
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Reset UI state
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Clears ~/.config/kobe/state.json and ~/.kobe/tasks.json, then quits kobe — relaunch to start fresh. Working
        session / Archive lists, pane sizes, theme, model picks all reset. Worktrees on disk and Claude Code session
        history are not touched.
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
          [enter] Reset
        </text>
      </box>
      <Show when={props.hasDaemon}>
        <box flexDirection="column" gap={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Restart backend
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            Stops the kobe daemon and quits this kobe window so the next launch spawns a fresh daemon — picks up daemon
            / orchestrator / engine edits without a process kill. Other attached kobe windows will lose their connection
            too.
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
              [enter] Restart
            </text>
          </box>
        </box>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        Daemon wedged or unresponsive? From a shell, run `kobe doctor` to diagnose, or `kobe reset` to stop the daemon +
        kill sessions (keeps your tasks). Use `kobe reset --hard` only to also wipe the task index + UI state.
      </text>

      <box flexDirection="column" gap={0} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Experimental
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          Remote projects (SSH): register a project whose git worktrees + engine run on another host over SSH, driven
          from this local kobe. Unfinished — file/diff panes still degrade for remote. Enables `kobe add --remote`.
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
            {props.remoteProjectsEnabled() ? "[x] Remote projects (on)" : "[ ] Remote projects (off)"}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          Auto status flow: a backlog task moves to in_progress when its engine starts a turn, and new claude sessions
          get a system-prompt note telling the agent to set in_review itself when the work is done. Never touches
          done/canceled.
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
            {props.autoStatusEnabled() ? "[x] Auto status flow (on)" : "[ ] Auto status flow (off)"}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          Field-notes dispatcher: task sessions file one-line gotchas (`kobe api note`), the daemon forwards each to the
          repo's main session, and that session relays them to the in-flight tasks that benefit (`kobe api dispatch`).
          Web-hosted sessions receive the relays today.
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
            {props.dispatcherEnabled() ? "[x] Field-notes dispatcher (on)" : "[ ] Field-notes dispatcher (off)"}
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
        Keybindings
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Rebind chords by editing the YAML below, then restart kobe (or respawn the pane). Press F1 anywhere for the live
        keymap with every binding id.
      </text>
      <box flexDirection="column" gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Config file
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {report.path}
          {report.exists ? "" : "  (not created yet)"}
        </text>
      </box>
      <Show when={!report.exists}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Example
          </text>
          <text fg={theme.textMuted}>bindings:</text>
          <text fg={theme.textMuted}>{"  chat.fork.new: ctrl+g      # string = one chord"}</text>
          <text fg={theme.textMuted}>{"  sidebar.select: [enter]    # list = several chords"}</text>
          <text fg={theme.textMuted}>{"  files.createPR: null       # null = unbind"}</text>
          <text fg={theme.textMuted}>{"  tmux.tab.new: ctrl+y       # tmux session key (see below)"}</text>
          <text fg={theme.textMuted}>{"darwin:                      # platform overlay (also: linux)"}</text>
          <text fg={theme.textMuted}>{"  bindings:"}</text>
          <text fg={theme.textMuted}>{"    palette.open: [cmd+p, ctrl+p]"}</text>
        </box>
      </Show>
      <Show when={report.exists}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Overrides applied
          </text>
          <Show when={report.applied.length === 0}>
            <text fg={theme.textMuted}>none</text>
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
            Warnings
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
          "tmux session keys use the same file: tmux.tab.new (ctrl+t), tmux.tab.prev/next (ctrl+[/]), tmux.tab.close (ctrl+w), tmux.tab.rename (f2), tmux.tab.chooseEngine (ctrl+shift+t), tmux.detach (ctrl+q), tmux.focus (4 chords, left/down/up/right). They apply when a session is (re)built."
        }
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {`Fixed (not rebindable): ${fixedIds.join(", ")}.`}
      </text>
    </box>
  )
}
