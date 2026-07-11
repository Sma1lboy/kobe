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
import { DEFAULT_PREFIX_CONFIGURATION, configurePrefix, resetPrefixConfiguration } from "../lib/keymap-dispatch"
import { type AppliedOverride, applyKeymapOverrides, extractKeybindingOverrides } from "../lib/keymap-overrides"
import { applyPrefixKeymapOverrides, extractPrefixKeybindings } from "../lib/keymap-prefix-overrides"
import { KobeKeymap, bumpKeymapVersion, resetKeymapToDefaults } from "./keybindings"

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
  const prefix = extractPrefixKeybindings(file.doc, process.platform)
  warnings.push(...prefix.warnings)
  configurePrefix({ ...DEFAULT_PREFIX_CONFIGURATION, ...prefix.configuration })

  // Partition by namespace: tmux.* entries belong to the session-key
  // layer; everything else targets KobeKeymap.
  const tmuxEntries = extracted.entries.filter((e) => e.id.startsWith("tmux."))
  const keymapEntries = extracted.entries.filter((e) => !e.id.startsWith("tmux."))
  const result = applyKeymapOverrides(KobeKeymap, keymapEntries)
  warnings.push(...result.warnings)
  const applied: AppliedOverride[] = [...result.applied]
  const prefixKey = prefix.configuration.key
  if (prefixKey !== null && prefixKey !== undefined) {
    const directOwner = KobeKeymap.find((row) => row.keys.includes(prefixKey))
    if (directOwner) warnings.push(`prefix.key "${prefixKey}" collides with direct binding ${directOwner.id}`)
  }
  const directIds = new Set(keymapEntries.map((entry) => entry.id))
  for (const entry of prefix.entries) {
    if (directIds.has(entry.id))
      warnings.push(`${entry.id}: configured in both bindings and prefix.bindings; prefix.bindings wins`)
  }
  // Prefix entries apply after direct entries, making the mode choice
  // deterministic when a user accidentally declares both forms.
  const prefixResult = applyPrefixKeymapOverrides(KobeKeymap, prefix.entries)
  warnings.push(...prefixResult.warnings)
  applied.push(...prefixResult.applied)

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

/** Report from the boot-time load (loading first if needed). */
export function userKeybindingsReport(): UserKeybindingsReport {
  return cached ?? applyUserKeybindings()
}

/**
 * Re-read `keybindings.yaml` and re-apply it from a clean slate — the
 * live-reload counterpart to {@link applyUserKeybindings} (KOB —
 * cross-session keybinding propagation). Invoked when the daemon's
 * keybindings watcher pings the `keybindings` channel.
 *
 * The order matters: the three per-process caches (file read, applied
 * report, tmux resolution) are dropped, then `KobeKeymap` is reset to its
 * boot-time defaults BEFORE re-applying — so removing an override actually
 * restores the default instead of leaving the stale chord behind. A
 * `keymapVersion` bump then re-renders the chord legends; binding BEHAVIOUR
 * needs no nudge, since the dispatcher re-reads chords on every keypress.
 *
 * Scope note: this refreshes the in-process keymap (every `kobe` pane's
 * chords + their legend display) and the tmux-hint DISPLAY. It does NOT
 * re-bind the tmux SERVER keys (`tmux.*`) — those are installed at session
 * build and still need a rebuild to change behaviour.
 */
export function reloadUserKeybindings(): UserKeybindingsReport {
  cached = null
  resetKeybindingsFileCache()
  resetTmuxKeysCache()
  resetKeymapToDefaults()
  resetPrefixConfiguration()
  const report = applyUserKeybindings()
  bumpKeymapVersion()
  return report
}
