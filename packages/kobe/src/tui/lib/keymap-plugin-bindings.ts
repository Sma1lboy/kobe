/**
 * User chords → plugin invocations, the `plugins:` section of
 * `~/.kobe/settings/keybindings.yaml`:
 *
 * ```yaml
 * plugins:                       # applies on every platform
 *   ctrl+g: pane:examples.lazygit.git
 *   f6: action:examples.notify.test
 * darwin:                        # platform overlay — wins per chord
 *   plugins:
 *     cmd+g: pane:examples.lazygit.git
 * ```
 *
 * Kobe ships NO default plugin chords — every chord here is the user's own
 * placement call (docs/KEYBINDINGS.md). Values are `pane:<plugin-id>.<pane>`
 * or `action:<plugin-id>.<action>`; the qualified id is resolved by the CLI
 * at fire time, so a chord for an uninstalled plugin parses fine and just
 * errors in the log when pressed. Zero-opentui module (vitest-importable);
 * chord grammar shared with keymap-overrides-parse.
 */

import { normalizeChord } from "./keymap-overrides-parse"

export type PluginKeyBinding = {
  /** Normalized chord (the exact candidate string matchKey mints). */
  readonly chord: string
  readonly kind: "pane" | "action"
  /** Qualified `<plugin-id>.<local-id>`. */
  readonly target: string
}

export type ExtractedPluginKeybindings = {
  entries: PluginKeyBinding[]
  warnings: string[]
}

const PLATFORM_SECTIONS: Readonly<Record<string, string[]>> = {
  darwin: ["darwin", "macos", "mac"],
  linux: ["linux"],
  win32: ["win32", "windows"],
}

const VALUE_RE = /^(pane|action):\s*([A-Za-z0-9][A-Za-z0-9._:-]*\.[A-Za-z0-9][A-Za-z0-9_:-]*)$/

function sectionOf(doc: unknown, key: string): Record<string, unknown> | null {
  if (typeof doc !== "object" || doc === null) return null
  const section = (doc as Record<string, unknown>)[key]
  if (typeof section !== "object" || section === null || Array.isArray(section)) return null
  return section as Record<string, unknown>
}

function collect(section: Record<string, unknown>, into: Map<string, PluginKeyBinding>, warnings: string[]): void {
  for (const [rawChord, rawValue] of Object.entries(section)) {
    if (typeof rawValue !== "string") {
      warnings.push(`plugins: ${rawChord}: value must be a "pane:<id>" or "action:<id>" string`)
      continue
    }
    const match = rawValue.trim().match(VALUE_RE)
    if (!match) {
      warnings.push(`plugins: ${rawChord}: \`${rawValue}\` is not pane:<plugin-id>.<local-id> or action:<...>`)
      continue
    }
    const chord = normalizeChord(rawChord)
    if ("error" in chord) {
      warnings.push(`plugins: ${rawChord}: ${chord.error}`)
      continue
    }
    if (chord.warning) warnings.push(`plugins: ${rawChord}: ${chord.warning}`)
    into.set(chord.chord, {
      chord: chord.chord,
      kind: match[1] as "pane" | "action",
      target: (match[2] as string).trim(),
    })
  }
}

/**
 * Extract the `plugins:` chord map for `platform`. Platform overlays win
 * per chord (same rule as `bindings:` overlays, applied per key).
 */
export function extractPluginKeybindings(doc: unknown, platform: string): ExtractedPluginKeybindings {
  const warnings: string[] = []
  const byChord = new Map<string, PluginKeyBinding>()
  const base = sectionOf(doc, "plugins")
  if (base) collect(base, byChord, warnings)
  for (const alias of PLATFORM_SECTIONS[platform] ?? []) {
    const overlaySection = sectionOf(doc, alias)
    const overlay = overlaySection ? sectionOf(overlaySection, "plugins") : null
    if (overlay) collect(overlay, byChord, warnings)
  }
  return { entries: [...byChord.values()], warnings }
}
