/**
 * Loader for user keybinding overrides — `~/.kobe/settings/keybindings.yaml`.
 *
 * Thin wrapper around the shared file reader
 * (`src/state/keybindings-file.ts` — kobe's CLI always runs under Bun,
 * so `Bun.YAML` is available) and the pure logic in
 * `src/tui/lib/keymap-overrides.ts`: extract the overrides for
 * `process.platform` and MUTATE the matching `KobeKeymap` rows in place.
 * Because every pane registers chords through `bindByIds`/`chordsOf` and
 * the help dialog / status bar render straight from `KobeKeymap`,
 * mutating the table once at boot re-points every surface — exactly the
 * "runtime overlay" the keymap's header comment reserved for a future
 * settings layer.
 *
 * `tmux.*` ids in the same file belong to the tmux session-key layer
 * (`src/tmux/keybindings.ts`, consumed by `ensureSession`); they're
 * routed there for validation and merged into this report so the
 * Settings → Keybindings section shows ONE unified view.
 *
 * Call `applyUserKeybindings()` ONCE per process, BEFORE the first
 * `render()` — same slot as `loadUserThemes()` in every TUI host. It is
 * idempotent (subsequent calls return the cached report), never throws,
 * and a missing file is the normal fresh-install case (no warning).
 *
 * Deliberately NOT applied at module import time: unit tests import
 * `KobeKeymap` and must see pristine defaults regardless of what the
 * developer's own `~/.kobe/settings/keybindings.yaml` says.
 */

import { readKeybindingsFile } from "../../state/keybindings-file"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_SINGLE_BINDING_DEFAULTS,
  resolveTmuxKeyEntries,
  tmuxChordOptsFor,
} from "../../tmux/keybindings"
import { type AppliedOverride, applyKeymapOverrides, extractKeybindingOverrides } from "../lib/keymap-overrides"
import { KobeKeymap } from "./keybindings"

export type UserKeybindingsReport = {
  /** Canonical config path (the `.yaml` spelling, even when `.yml` was read). */
  path: string
  /** Whether a config file was found at all. */
  exists: boolean
  /** Overrides that landed (opentui keymap + tmux session keys). */
  applied: AppliedOverride[]
  /** Everything that didn't parse / validate / apply, human-readable. */
  warnings: string[]
}

let cached: UserKeybindingsReport | null = null

/**
 * Load `~/.kobe/settings/keybindings.yaml` and apply it onto `KobeKeymap`.
 * Idempotent; returns the (cached) report. Warnings are also mirrored to
 * `console.warn` so they land in the pane's log even if nobody opens the
 * Settings → Keybindings section.
 */
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

  // Partition by namespace: tmux.* entries belong to the session-key
  // layer; everything else targets KobeKeymap.
  const tmuxEntries = extracted.entries.filter((e) => e.id.startsWith("tmux."))
  const keymapEntries = extracted.entries.filter((e) => !e.id.startsWith("tmux."))

  const result = applyKeymapOverrides(KobeKeymap, keymapEntries)
  warnings.push(...result.warnings)
  const applied: AppliedOverride[] = [...result.applied]

  // Validate tmux entries with the same resolver `ensureSession` uses,
  // so the report shows what will actually bind (and why something
  // won't). The resolver itself runs again, cached, in whatever process
  // installs the session — same file, same logic, same outcome.
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
    }
  }

  for (const w of warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = { path: file.path, exists: true, applied, warnings }
  return cached
}

/** Report from the boot-time load (loading first if needed). */
export function userKeybindingsReport(): UserKeybindingsReport {
  return cached ?? applyUserKeybindings()
}
