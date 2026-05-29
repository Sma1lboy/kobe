import { TextAttributes } from "@opentui/core"
import { type Accessor, For, type Setter, Show } from "solid-js"
import type { ClaudeAccount, CodexAccount, CopilotAccount, EngineAccountStatus } from "../../../engine/account-detect"
import { VENDOR_LABEL } from "../../../engine/interactive-command"
import type { VendorId } from "../../../types/task"
import { FOCUS_ACCENT_SLOTS, useTheme } from "../../context/theme"
import {
  FOCUS_ACCENT_LABEL,
  type NavLevel,
  SECTIONS,
  type SectionId,
  soundRowIndex,
  toastRowIndex,
  transparentRowIndex,
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
    toastEnabled: Accessor<boolean>
    soundEnabled: Accessor<boolean>
    toggleToast: () => void
    toggleSound: () => void
  },
) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const toastRow = () => toastRowIndex(props.themeNames().length, FOCUS_ACCENT_SLOTS.length)
  const soundRow = () => soundRowIndex(props.themeNames().length, FOCUS_ACCENT_SLOTS.length)
  const isTransparentRow = () => props.bodyRow() === transparentRowIndex(props.themeNames().length)
  const isToastRow = () => props.bodyRow() === toastRow()
  const isSoundRow = () => props.bodyRow() === soundRow()

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
                  themeCtx.set(name)
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
            props.setBodyRow(transparentRowIndex(props.themeNames().length))
            themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
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
          {(slot, i) => {
            const rowIndex = () => props.themeNames().length + 1 + i()
            const isCursor = () => props.level() === "body" && props.bodyRow() === rowIndex()
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
                  props.setBodyRow(rowIndex())
                  themeCtx.setFocusAccent(slot)
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
    </box>
  )
}

export function EngineSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    vendors: readonly VendorId[]
    /** Current launch command shown for a vendor (override or default). */
    commandText: (vendor: VendorId) => string
    /** Whether the shown command is the built-in default (dims it). */
    isDefault: (vendor: VendorId) => boolean
    /** Open the editor for a vendor's launch command. */
    editEngine: (vendor: VendorId) => void
  },
) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Launch command
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        The command each engine's task pane runs. Override it when your binary isn't on PATH as `claude` / `codex` (e.g.
        it's `cl`) or to pass default flags. enter to edit · takes effect on the next task enter.
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
                <text
                  fg={isCursor() ? theme.selectedListItemText : theme.text}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                >
                  {VENDOR_LABEL[vendor]}
                </text>
                <text
                  fg={
                    isCursor() ? theme.selectedListItemText : props.isDefault(vendor) ? theme.textMuted : theme.accent
                  }
                  wrapMode="none"
                >
                  {props.commandText(vendor)}
                  {props.isDefault(vendor) ? "  (default)" : ""}
                </text>
              </box>
            )
          }}
        </For>
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

export function DevSettingsSection(
  props: CursorSetters & {
    level: Accessor<NavLevel>
    bodyRow: Accessor<number>
    hasDaemon: boolean
    confirmReset: () => void
    confirmRestartDaemon: () => void
  },
) {
  const { theme } = useTheme()
  const resetIsCursor = () => props.level() === "body" && props.bodyRow() === 0
  const restartIsCursor = () => props.level() === "body" && props.bodyRow() === 1
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
    </box>
  )
}
