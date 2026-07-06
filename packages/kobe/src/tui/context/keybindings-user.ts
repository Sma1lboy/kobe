import { readKeybindingsFile, resetKeybindingsFileCache } from "../../state/keybindings-file"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_SINGLE_BINDING_DEFAULTS,
  isTmuxPrefixBindingId,
  resetTmuxKeysCache,
  resolveTmuxKeyEntries,
  tmuxChordOptsFor,
} from "../../tmux/keybindings"
import { type AppliedOverride, applyKeymapOverrides, extractKeybindingOverrides } from "../lib/keymap-overrides"
import { KobeKeymap, bumpKeymapVersion, resetKeymapToDefaults } from "./keybindings"

export type UserKeybindingsReport = {
  path: string
  exists: boolean
  applied: AppliedOverride[]
  warnings: string[]
}

let cached: UserKeybindingsReport | null = null

export function applyUserKeybindings(): UserKeybindingsReport {
  if (cached) return cached
  const file = readKeybindingsFile()
  if (!file.exists) {
    cached = { path: file.path, exists: false, applied: [], warnings: [] }
    return cached
  }

  const warnings: string[] = [...file.warnings]
  const extracted = extractKeybindingOverrides(file.doc, process.platform, { chordOptsFor: tmuxChordOptsFor })
  warnings.push(...extracted.warnings)

  const tmuxEntries = extracted.entries.filter((e) => e.id.startsWith("tmux."))
  const keymapEntries = extracted.entries.filter((e) => !e.id.startsWith("tmux."))

  const result = applyKeymapOverrides(KobeKeymap, keymapEntries)
  warnings.push(...result.warnings)
  const applied: AppliedOverride[] = [...result.applied]

  if (tmuxEntries.length > 0) {
    const tmuxRes = resolveTmuxKeyEntries(tmuxEntries)
    warnings.push(...tmuxRes.warnings)
    for (const id of tmuxRes.overridden) {
      if (id === TMUX_FOCUS_ID) {
        applied.push({
          id,
          keys: tmuxRes.focus.map((b) => b?.chord ?? "").filter((c) => c !== ""),
          defaultKeys: TMUX_FOCUS_DEFAULTS,
        })
        continue
      }
      const bind = tmuxRes.binds[id as keyof typeof tmuxRes.binds]
      applied.push({
        id,
        keys: bind ? [bind.chord] : [],
        defaultKeys: [TMUX_SINGLE_BINDING_DEFAULTS[id as keyof typeof TMUX_SINGLE_BINDING_DEFAULTS]],
      })
      const displayRow = KobeKeymap.find((row) => row.id === id)
      if (displayRow?.hint) {
        displayRow.hint.keys = bind ? `${isTmuxPrefixBindingId(id) ? "prefix " : ""}${bind.chord}` : "—"
      }
    }
  }

  for (const w of warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = { path: file.path, exists: true, applied, warnings }
  return cached
}

export function userKeybindingsReport(): UserKeybindingsReport {
  return cached ?? applyUserKeybindings()
}

export function reloadUserKeybindings(): UserKeybindingsReport {
  cached = null
  resetKeybindingsFileCache()
  resetTmuxKeysCache()
  resetKeymapToDefaults()
  const report = applyUserKeybindings()
  bumpKeymapVersion()
  return report
}
