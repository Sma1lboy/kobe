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
import { DEFAULT_PREFIX_CONFIGURATION, configurePrefix, resetPrefixConfiguration } from "../lib/keymap-dispatch"
import { type AppliedOverride, applyKeymapOverrides, extractKeybindingOverrides } from "../lib/keymap-overrides"
import { type PluginKeyBinding, extractPluginKeybindings } from "../lib/keymap-plugin-bindings"
import { applyPrefixKeymapOverrides, extractPrefixKeybindings } from "../lib/keymap-prefix-overrides"
import { KobeKeymap, bumpKeymapVersion, resetKeymapToDefaults } from "./keybindings"

export type UserKeybindingsReport = {
  /** Canonical config path (the `.yaml` spelling, even when `.yml` was read). */
  path: string
  /** Whether a config file was found at all. */
  exists: boolean
  /** Overrides that landed in the workspace keymap. */
  applied: AppliedOverride[]
  /** User chords bound to plugin panes/actions (`plugins:` section). */
  plugins: PluginKeyBinding[]
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
    cached = { path: file.path, exists: false, applied: [], plugins: [], warnings: [] }
    return cached
  }

  const warnings: string[] = [...file.warnings]
  const extracted = extractKeybindingOverrides(file.doc, process.platform)
  warnings.push(...extracted.warnings)
  const prefix = extractPrefixKeybindings(file.doc, process.platform)
  warnings.push(...prefix.warnings)
  configurePrefix({ ...DEFAULT_PREFIX_CONFIGURATION, ...prefix.configuration })

  const result = applyKeymapOverrides(KobeKeymap, extracted.entries)
  warnings.push(...result.warnings)
  const applied: AppliedOverride[] = [...result.applied]
  const prefixKey = prefix.configuration.key
  if (prefixKey !== null && prefixKey !== undefined) {
    const directOwner = KobeKeymap.find((row) => row.keys.includes(prefixKey))
    if (directOwner) warnings.push(`prefix.key "${prefixKey}" collides with direct binding ${directOwner.id}`)
  }
  const prefixResult = applyPrefixKeymapOverrides(KobeKeymap, [...extracted.prefixEntries, ...prefix.entries])
  warnings.push(...prefixResult.warnings)
  applied.push(...prefixResult.applied)

  // User chords → plugin panes/actions. Collisions with catalogue chords are
  // the user's own placement call — warn, still apply (host-level plugin
  // bindings sit above pane bindings in the keymap stack).
  const plugins = extractPluginKeybindings(file.doc, process.platform)
  warnings.push(...plugins.warnings)
  for (const p of plugins.entries) {
    const owner = KobeKeymap.find((row) => row.keys.includes(p.chord))
    if (owner) warnings.push(`plugins: ${p.chord} shadows ${owner.id}`)
  }

  for (const w of warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = { path: file.path, exists: true, applied, plugins: plugins.entries, warnings }
  return cached
}

/** The user's plugin chords (loading the config first if needed). */
export function pluginKeybindings(): readonly PluginKeyBinding[] {
  return userKeybindingsReport().plugins
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
 * report) are dropped, then `KobeKeymap` is reset to its
 * boot-time defaults BEFORE re-applying — so removing an override actually
 * restores the default instead of leaving the stale chord behind. A
 * `keymapVersion` bump then re-renders the chord legends; binding BEHAVIOUR
 * needs no nudge, since the dispatcher re-reads chords on every keypress.
 *
 * Scope note: this refreshes the in-process keymap and its legend display.
 */
export function reloadUserKeybindings(): UserKeybindingsReport {
  cached = null
  resetKeybindingsFileCache()
  resetKeymapToDefaults()
  resetPrefixConfiguration()
  const report = applyUserKeybindings()
  bumpKeymapVersion()
  return report
}
