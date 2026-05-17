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
import { Show, createMemo, createSignal, onMount } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator"
import {
  type ClaudeAccount,
  type CodexAccount,
  type EngineAccountStatus,
  type GeminiAccount,
  detectClaudeAccount,
  detectCodexAccount,
  detectGeminiAccount,
} from "../../engine/account-detect"
import { CODEX_BACKEND_KV_KEY, type CodexBackend } from "../../engine/codex-local/app-server"
import type { KVContext } from "../context/kv"
import { FOCUS_ACCENT_SLOTS, useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { confirmResetState, confirmRestartDaemon, hasRestartableDaemon } from "./settings-dialog/actions"
import {
  CODEX_BACKENDS,
  type NavLevel,
  SECTIONS,
  type SectionId,
  bodyRowCount as countBodyRows,
  focusAccentRowIndex,
  soundRowIndex,
  toastRowIndex,
  transparentRowIndex,
} from "./settings-dialog/model"
import {
  AccountsSettingsSection,
  CodexSettingsSection,
  DevSettingsSection,
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
  const [claudeStatus, setClaudeStatus] = createSignal<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codexStatus, setCodexStatus] = createSignal<EngineAccountStatus<CodexAccount> | null>(null)
  const [geminiStatus, setGeminiStatus] = createSignal<EngineAccountStatus<GeminiAccount> | null>(null)

  onMount(() => {
    void detectClaudeAccount()
      .then(setClaudeStatus)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("kobe: detectClaudeAccount threw:", err)
        setClaudeStatus({ binary: { found: false, error: String(err) }, account: { kind: "none" } })
      })
    void detectCodexAccount()
      .then(setCodexStatus)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("kobe: detectCodexAccount threw:", err)
        setCodexStatus({ binary: { found: false, error: String(err) }, account: { kind: "none" } })
      })
    void detectGeminiAccount()
      .then(setGeminiStatus)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("kobe: detectGeminiAccount threw:", err)
        setGeminiStatus({ binary: { found: false, error: String(err) }, account: { kind: "none" } })
      })
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

  function codexBackend(): CodexBackend {
    const raw = props.kv.get(CODEX_BACKEND_KV_KEY, "app-server")
    return raw === "exec" || raw === "app-server" ? raw : "app-server"
  }

  function setCodexBackend(next: CodexBackend): void {
    props.kv.set(CODEX_BACKEND_KV_KEY, next)
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
      const name = themeNames()[bodyRow()]
      if (name) themeCtx.set(name)
      return
    }
    if (section() === "codex") {
      const backend = CODEX_BACKENDS[bodyRow()]
      if (backend) setCodexBackend(backend)
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
            />
          </Show>
          <Show when={section() === "accounts"}>
            <AccountsSettingsSection
              claudeStatus={claudeStatus}
              codexStatus={codexStatus}
              geminiStatus={geminiStatus}
            />
          </Show>
          <Show when={section() === "codex"}>
            <CodexSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              codexBackend={codexBackend}
              setCodexBackend={setCodexBackend}
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
