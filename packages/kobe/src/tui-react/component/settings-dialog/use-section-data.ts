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
import { type PluginRowView, readPluginRows, setPluginEnabled } from "./plugins-core"

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
}

/**
 * Registered plugins, re-read every time the section is opened so an
 * install from another terminal shows up without restarting kobe.
 */
export function usePluginSettings(section: SectionId): PluginSettings {
  const [rows, setRows] = useState<readonly PluginRowView[]>([])
  useEffect(() => {
    if (section !== "plugins") return
    setRows(readPluginRows())
  }, [section])
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
  }
}
