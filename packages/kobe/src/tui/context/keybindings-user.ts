/**
 * Loader for user keybinding overrides — `~/.kobe/settings/keybindings.yaml`.
 *
 * Thin Bun-runtime wrapper around the pure logic in
 * `src/tui/lib/keymap-overrides.ts`: read the YAML (Bun.YAML — kobe's CLI
 * always runs under Bun, the dist shebang is `#!/usr/bin/env bun`), extract
 * the overrides for `process.platform`, and MUTATE the matching `KobeKeymap`
 * rows in place. Because every pane registers chords through
 * `bindByIds`/`chordsOf` and the help dialog / status bar render straight
 * from `KobeKeymap`, mutating the table once at boot re-points every
 * surface — exactly the "runtime overlay" the keymap's header comment
 * reserved for a future settings layer.
 *
 * Call `applyUserKeybindings()` ONCE per process, BEFORE the first
 * `render()` — same slot as `loadUserThemes()` in every TUI host. It is
 * idempotent (subsequent calls return the cached report), never throws,
 * and a missing file is the normal fresh-install case (no warning).
 *
 * Deliberately NOT applied at module import time: unit tests import
 * `KobeKeymap` and must see pristine defaults regardless of what the
 * developer's own `~/.kobe/settings/keybindings.yaml` says.
 *
 * tmux-layer keys (ctrl+t / ctrl+[ / ctrl+] / ctrl+w / ctrl+hjkl inside a
 * direct-tmux handover) are real tmux server bindings installed by
 * `src/tui/panes/terminal/tmux.ts` — this loader does not reach them.
 */

import { existsSync, readFileSync } from "node:fs"
import { keybindingsConfigPath } from "../../env"
import { type AppliedOverride, applyKeymapOverrides, extractKeybindingOverrides } from "../lib/keymap-overrides"
import { KobeKeymap } from "./keybindings"

export type UserKeybindingsReport = {
  /** Canonical config path (the `.yaml` spelling, even when `.yml` was read). */
  path: string
  /** Whether a config file was found at all. */
  exists: boolean
  /** Overrides that landed on the keymap. */
  applied: AppliedOverride[]
  /** Everything that didn't parse / validate / apply, human-readable. */
  warnings: string[]
}

let cached: UserKeybindingsReport | null = null

/** Resolve the config file, accepting `.yml` when `.yaml` is absent. */
function resolveConfigFile(): { canonical: string; found: string | null } {
  const canonical = keybindingsConfigPath()
  if (existsSync(canonical)) return { canonical, found: canonical }
  const yml = canonical.replace(/\.yaml$/, ".yml")
  if (existsSync(yml)) return { canonical, found: yml }
  return { canonical, found: null }
}

/**
 * Load `~/.kobe/settings/keybindings.yaml` and apply it onto `KobeKeymap`.
 * Idempotent; returns the (cached) report. Warnings are also mirrored to
 * `console.warn` so they land in the pane's log even if nobody opens the
 * Settings → Keybindings section.
 */
export function applyUserKeybindings(): UserKeybindingsReport {
  if (cached) return cached
  const { canonical, found } = resolveConfigFile()
  if (!found) {
    cached = { path: canonical, exists: false, applied: [], warnings: [] }
    return cached
  }

  const warnings: string[] = []
  let doc: unknown
  try {
    const text = readFileSync(found, "utf8")
    doc = Bun.YAML.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`could not read/parse ${found}: ${msg}`)
    doc = null
  }

  const extracted = extractKeybindingOverrides(doc, process.platform)
  warnings.push(...extracted.warnings)
  const result = applyKeymapOverrides(KobeKeymap, extracted.entries)
  warnings.push(...result.warnings)

  for (const w of warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = { path: canonical, exists: true, applied: result.applied, warnings }
  return cached
}

/** Report from the boot-time load (loading first if needed). */
export function userKeybindingsReport(): UserKeybindingsReport {
  return cached ?? applyUserKeybindings()
}
