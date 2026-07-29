/**
 * Section data the Settings dialog reads from OUTSIDE its own kv state —
 * engine account probes (fs/env) and the plugin registry (`~/.kobe/
 * plugins.json`). Both are lazy: nothing is read until the owning section
 * is first opened, so a settings open that never visits them pays nothing.
 * Split out of `index.tsx` for the file-size cap, like `use-settings-prefs`
 * / `use-engine-settings`.
 */

import { useEffect, useRef, useState } from "react"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type EngineAccountStatus,
  type KimiAccount,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
  detectKimiAccount,
} from "../../../engine/account-detect"
import type { SectionId } from "../../../tui/component/settings-dialog/model"
import { useT } from "../../i18n"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { RenameTaskDialog } from "../rename-task-dialog"
import { nextEnumValue, normalizeNumberInput, toggledBooleanValue } from "./plugin-settings-core"
import { type PluginRowView, readPluginRows, setPluginEnabled, setPluginSetting } from "./plugins-core"

export interface AccountProbes {
  claude: EngineAccountStatus<ClaudeAccount> | null
  codex: EngineAccountStatus<CodexAccount> | null
  copilot: EngineAccountStatus<CopilotAccount> | null
  kimi: EngineAccountStatus<KimiAccount> | null
}

/** Read-only login detection, probed once per dialog mount. */
export function useAccountProbes(section: SectionId): AccountProbes {
  const [claude, setClaude] = useState<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codex, setCodex] = useState<EngineAccountStatus<CodexAccount> | null>(null)
  const [copilot, setCopilot] = useState<EngineAccountStatus<CopilotAccount> | null>(null)
  const [kimi, setKimi] = useState<EngineAccountStatus<KimiAccount> | null>(null)
  const probed = useRef(false)
  useEffect(() => {
    if (section !== "accounts" || probed.current) return
    probed.current = true
    void detectClaudeAccount().then(setClaude)
    void detectCodexAccount().then(setCodex)
    void detectCopilotAccount().then(setCopilot)
    void detectKimiAccount().then(setKimi)
  }, [section])
  return { claude, codex, copilot, kimi }
}

export interface PluginSettings {
  readonly rows: readonly PluginRowView[]
  /** Flip a plugin's enabled flag; the daemon picks the write up live. */
  readonly toggle: (id: string) => void
  /** Activate one declared setting: cycle an enum, flip a boolean, or prompt. */
  readonly editSetting: (pluginId: string, key: string) => Promise<void>
}

/**
 * Registered plugins, re-read every time the section is opened so an
 * install from another terminal shows up without restarting kobe.
 */
export function usePluginSettings(section: SectionId, dialog: DialogContext): PluginSettings {
  const [rows, setRows] = useState<readonly PluginRowView[]>([])
  const t = useT()
  useEffect(() => {
    if (section !== "plugins") return
    setRows(readPluginRows())
  }, [section])

  /** Every write goes through here: store, then re-read so disk wins. */
  function store(pluginId: string, key: string, value: string): void {
    try {
      setPluginSetting(pluginId, key, value)
    } catch {
      // .env unwritable — the re-read leaves the row showing what disk has.
    }
    setRows(readPluginRows())
  }

  return {
    rows,
    toggle: (id: string) => {
      const row = rows.find((p) => p.id === id)
      if (!row) return
      try {
        setPluginEnabled(id, !row.enabled)
      } catch {
        // Registry unwritable — the re-read below leaves the row as disk has it.
      }
      setRows(readPluginRows())
    },
    editSetting: async (pluginId: string, key: string) => {
      const setting = rows.find((p) => p.id === pluginId)?.settings.find((s) => s.key === key)
      if (!setting) return
      if (setting.type === "enum") {
        store(pluginId, key, nextEnumValue(setting.options, setting.value))
        return
      }
      if (setting.type === "boolean") {
        store(pluginId, key, toggledBooleanValue(setting))
        return
      }
      const next = await RenameTaskDialog.show(dialog, setting.value, {
        // The label is plugin-owned copy, like an action title — shown raw.
        dialogTitle: setting.label,
        fieldLabel: key,
        submitLabel: "save",
        allowEmpty: true,
        placeholder: setting.defaultValue,
      })
      if (next === undefined) return
      if (setting.type !== "number") {
        store(pluginId, key, next.trim())
        return
      }
      const numeric = normalizeNumberInput(next)
      if (numeric === null) {
        await DialogConfirm.show(
          dialog,
          t("settings.plugins.settingInvalidTitle"),
          t("settings.plugins.settingInvalidBody", { label: setting.label }),
          "cancel",
        )
        return
      }
      store(pluginId, key, numeric)
    },
  }
}
