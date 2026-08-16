/**
 * Shared reader for `~/.rove/settings/keybindings.yaml`.
 *
 * The framework-free reader lives here so config IO remains separate from
 * the keymap mutation performed by `tui/context/keybindings-user.ts`.
 *
 * Read once per process and cached: the TUI applies keybindings at boot
 * and the daemon watcher explicitly clears this cache for live reloads.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { errorMessage } from "@/lib/error-message"
import { isMap, parseDocument } from "yaml"
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

/**
 * Drop the cached read so the next {@link readKeybindingsFile} hits disk
 * again. Used by the live-reload path (`reloadUserKeybindings`) when the
 * daemon's keybindings watcher reports the file changed; the boot read is
 * otherwise "once per process".
 */
export function resetKeybindingsFileCache(): void {
  cached = null
}

/** Resolve the config file, accepting `.yml` when `.yaml` is absent. */
function resolveConfigFile(): { canonical: string; found: string | null } {
  const canonical = keybindingsConfigPath()
  if (existsSync(canonical)) return { canonical, found: canonical }
  const yml = canonical.replace(/\.yaml$/, ".yml")
  if (existsSync(yml)) return { canonical, found: yml }
  return { canonical, found: null }
}

function platformKeys(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["darwin", "macos", "mac"]
  if (platform === "win32") return ["win32", "windows"]
  return [platform]
}

/**
 * Persist the prefix first stroke without flattening the rest of the user's
 * YAML. If the effective key comes from a platform overlay, update that same
 * overlay; otherwise write the shared `prefix.key` value.
 */
export function writePrefixKey(key: string | null, platform: NodeJS.Platform = process.platform): string {
  const { canonical, found } = resolveConfigFile()
  // Always write the canonical path. The daemon watches keybindings.yaml for
  // cross-window reloads; when only the legacy .yml spelling exists, copying
  // its document here promotes it without flattening or discarding settings.
  const target = canonical
  const source = found ? readFileSync(found, "utf8") : ""
  const doc = parseDocument(source)
  if (doc.errors.length > 0) throw new Error(`could not parse ${target}: ${doc.errors[0]?.message ?? "invalid YAML"}`)
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${target} must contain a YAML mapping`)

  const overlay = platformKeys(platform)
    .filter((name) => doc.hasIn([name, "prefix", "key"]))
    .at(-1)
  doc.setIn(overlay ? [overlay, "prefix", "key"] : ["prefix", "key"], key)

  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const mode = found ? statSync(found).mode & 0o777 : 0o600
  writeFileSync(tmp, doc.toString({ lineWidth: 0 }), { encoding: "utf8", mode })
  renameSync(tmp, target)
  resetKeybindingsFileCache()
  return target
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
    const msg = errorMessage(err)
    warnings.push(`could not read/parse ${found}: ${msg}`)
  }
  cached = { path: canonical, exists: true, doc, warnings }
  return cached
}
