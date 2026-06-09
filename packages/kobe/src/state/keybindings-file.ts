/**
 * Shared reader for `~/.kobe/settings/keybindings.yaml`.
 *
 * Two consumers parse this file, in different layers of the stack:
 *   - the opentui keymap loader (`src/tui/context/keybindings-user.ts`),
 *     which mutates `KobeKeymap`;
 *   - the tmux-layer resolver (`src/tmux/keybindings.ts`), which feeds
 *     the no-prefix session bindings `ensureSession` installs.
 * The second must stay importable without `@opentui/*` (tmux.ts is
 * vitest-imported), so the file read lives here — node:fs + Bun.YAML
 * only — instead of inside the opentui-tainted loader.
 *
 * Read once per process and cached: the TUI applies keybindings at boot
 * and never re-reads (edits require a restart / pane respawn), so a
 * second disk read could only introduce inconsistency between the two
 * consumers, never fix one.
 */

import { existsSync, readFileSync } from "node:fs"
import { keybindingsConfigPath } from "../env"

export type KeybindingsFile = {
  /** Canonical config path (the `.yaml` spelling, even when `.yml` was read). */
  path: string
  /** Whether a config file was found at all. */
  exists: boolean
  /** Parsed YAML document, or null when missing/unparseable. */
  doc: unknown
  /** Read/parse-level problems (NOT per-binding validation). */
  warnings: string[]
}

let cached: KeybindingsFile | null = null

/** Resolve the config file, accepting `.yml` when `.yaml` is absent. */
function resolveConfigFile(): { canonical: string; found: string | null } {
  const canonical = keybindingsConfigPath()
  if (existsSync(canonical)) return { canonical, found: canonical }
  const yml = canonical.replace(/\.yaml$/, ".yml")
  if (existsSync(yml)) return { canonical, found: yml }
  return { canonical, found: null }
}

/** Read + parse the keybindings YAML once; never throws. */
export function readKeybindingsFile(): KeybindingsFile {
  if (cached) return cached
  const { canonical, found } = resolveConfigFile()
  if (!found) {
    cached = { path: canonical, exists: false, doc: null, warnings: [] }
    return cached
  }
  const warnings: string[] = []
  let doc: unknown = null
  try {
    const text = readFileSync(found, "utf8")
    doc = Bun.YAML.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`could not read/parse ${found}: ${msg}`)
  }
  cached = { path: canonical, exists: true, doc, warnings }
  return cached
}
