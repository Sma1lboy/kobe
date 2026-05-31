/**
 * Settings dialog — two-column layout with a left sidebar (sections)
 * and a right pane (the active section's content).
 *
 * Bindings inside the dialog:
 *   - `↑` / `↓` / `j` / `k` — navigate the current level.
 *   - `h` / `l`              — switch sidebar/body levels.
 *   - `enter`                — activate the focused row.
 *   - `esc`                  — close (handled by the dialog stack).
 */

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
import { VENDOR_LABEL, defaultEngineCommand, engineCommandKey } from "../../engine/interactive-command"
import type { VendorId } from "../../types/task"
import { ALL_VENDORS } from "../../types/vendor"
import type { KVContext } from "../context/kv"
import { FOCUS_ACCENT_SLOTS, useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  type SettingsSurface,
  normalizeSettingsSurface,
} from "../lib/settings-surface"
import { type DialogContext, useDialog } from "../ui/dialog"
import { RenameTaskDialog } from "./rename-task-dialog"
import { confirmResetState, confirmRestartDaemon, hasRestartableDaemon } from "./settings-dialog/actions"
import {
  type NavLevel,
  SECTIONS,
  type SectionId,
  bodyRowCount as countBodyRows,
  focusAccentRowIndex,
  soundRowIndex,
  surfaceChattabRowIndex,
  surfaceTaskpanelRowIndex,
  toastRowIndex,
  transparentRowIndex,
} from "./settings-dialog/model"
import {
  AccountsSettingsSection,
  DevSettingsSection,
  EngineSettingsSection,
  GeneralSettingsSection,
  SettingsSectionSidebar,
} from "./settings-dialog/sections"

export type SettingsDialogProps = {
  kv: KVContext
  /**
   * The active orchestrator. Used to expose the "Restart backend" Dev
   * button only when we're attached to a daemon (RemoteOrchestrator).
   */
  orchestrator?: KobeOrchestrator
  onClose: () => void
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
  const themeNames = createMemo<readonly string[]>(() => themeCtx.all().slice().sort())
  const [, setThemeCursor] = createSignal(
    Math.max(
      0,
      themeNames().findIndex((n) => n === themeCtx.selected),
    ),
  )
  const hasDaemon = hasRestartableDaemon(props.orchestrator)

  // Account detection (KOB-249): read-only fs/env probes, lazily run the
  // first time the Accounts section is opened so a settings open that
  // never visits it pays nothing.
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

  function bodyRowCount(): number {
    return countBodyRows(section(), themeNames().length, FOCUS_ACCENT_SLOTS.length, hasDaemon)
  }

  function isTransparentRow(): boolean {
    return section() === "general" && bodyRow() === transparentRowIndex(themeNames().length)
  }

  function currentFocusAccentRow(): number | null {
    if (section() !== "general") return null
    return focusAccentRowIndex(bodyRow(), themeNames().length, FOCUS_ACCENT_SLOTS.length)
  }

  function isToastRow(): boolean {
    return section() === "general" && bodyRow() === toastRowIndex(themeNames().length, FOCUS_ACCENT_SLOTS.length)
  }

  function isSoundRow(): boolean {
    return section() === "general" && bodyRow() === soundRowIndex(themeNames().length, FOCUS_ACCENT_SLOTS.length)
  }

  function isSurfaceChattabRow(): boolean {
    return (
      section() === "general" && bodyRow() === surfaceChattabRowIndex(themeNames().length, FOCUS_ACCENT_SLOTS.length)
    )
  }

  function isSurfaceTaskpanelRow(): boolean {
    return (
      section() === "general" && bodyRow() === surfaceTaskpanelRowIndex(themeNames().length, FOCUS_ACCENT_SLOTS.length)
    )
  }

  function settingsSurface(): SettingsSurface {
    return normalizeSettingsSurface(props.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
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

  // Engines section: per-vendor launch command. Stored in the shared
  // state.json under engineCommandKey via kv (reactive here; read
  // cross-process by interactiveEngineCommand). Empty override = default.
  function engineOverride(vendor: VendorId): string {
    const v = props.kv.get(engineCommandKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineCommandText(vendor: VendorId): string {
    return engineOverride(vendor) || defaultEngineCommand(vendor).join(" ")
  }
  function engineIsDefault(vendor: VendorId): boolean {
    return engineOverride(vendor).length === 0
  }
  async function editEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineCommandText(vendor), {
      dialogTitle: `${VENDOR_LABEL[vendor]} launch command`,
    })
    if (next === undefined) return
    props.kv.set(engineCommandKey(vendor), next.trim())
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
    if (section() === "general" && next < themeNames().length) setThemeCursor(next)
  }

  function switchSection(id: SectionId): void {
    setSection(id)
    setCursor(SECTIONS.findIndex((s) => s.id === id))
    setBodyRow(0)
    setLevel("sidebar")
  }

  function activateBodyRow(): void {
    if (section() === "general") {
      if (isTransparentRow()) {
        themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
        return
      }
      const focusIdx = currentFocusAccentRow()
      if (focusIdx !== null) {
        const slot = FOCUS_ACCENT_SLOTS[focusIdx]
        if (slot) themeCtx.setFocusAccent(slot)
        return
      }
      if (isToastRow()) {
        toggleToast()
        return
      }
      if (isSoundRow()) {
        toggleSound()
        return
      }
      if (isSurfaceChattabRow()) {
        selectSurface("chattab")
        return
      }
      if (isSurfaceTaskpanelRow()) {
        selectSurface("taskpanel")
        return
      }
      const name = themeNames()[bodyRow()]
      if (name) themeCtx.set(name)
      return
    }
    if (section() === "engines") {
      const vendor = ALL_VENDORS[bodyRow()]
      if (vendor) void editEngine(vendor)
      return
    }
    if (section() === "dev") {
      if (bodyRow() === 0) void confirmResetState(dialog, props.kv, renderer)
      else if (hasDaemon && bodyRow() === 1) void confirmRestartDaemon(dialog, props.orchestrator, renderer)
    }
  }

  useBindings(() => ({
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
        cmd: () => themeCtx.setTransparentBackground(!themeCtx.transparentBackground),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Settings
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          esc
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
              toastEnabled={toastEnabled}
              soundEnabled={soundEnabled}
              toggleToast={toggleToast}
              toggleSound={toggleSound}
              settingsSurface={settingsSurface}
              selectSurface={selectSurface}
            />
          </Show>
          <Show when={section() === "engines"}>
            <EngineSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              vendors={ALL_VENDORS}
              commandText={engineCommandText}
              isDefault={engineIsDefault}
              editEngine={(v) => void editEngine(v)}
            />
          </Show>
          <Show when={section() === "accounts"}>
            <AccountsSettingsSection
              claudeStatus={claudeStatus}
              codexStatus={codexStatus}
              copilotStatus={copilotStatus}
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
            />
          </Show>
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>j/k pick · h/l switch level · enter activate · esc close</text>
      </box>
    </box>
  )
}

SettingsDialog.show = (dialog: DialogContext, kv: KVContext, orchestrator?: KobeOrchestrator): Promise<void> => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <SettingsDialog kv={kv} orchestrator={orchestrator} onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
