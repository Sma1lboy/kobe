/**
 * Pure prefix-specific settings for the Workspace Host Binding Stack.
 * Kept apart from direct-chord overrides so `tmux.*` consumers can continue
 * using keymap-overrides.ts without learning PureTUI sequence semantics.
 */

import { type AppliedOverride, type KeymapOverrideEntry, normalizeChord } from "./keymap-overrides"

export type PrefixOverridableBinding = {
  id: string
  keys: readonly string[]
  prefixKeys?: readonly string[]
}

export type PrefixConfigurationOverride = {
  key?: string | null
  timeoutMs?: number
}

export type PrefixExtraction = {
  configuration: PrefixConfigurationOverride
  entries: KeymapOverrideEntry[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function platformKeys(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["darwin", "macos", "mac"]
  if (platform === "win32") return ["win32", "windows"]
  return [platform]
}

function collectEntries(source: unknown, warnings: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (source === undefined) return out
  if (!isRecord(source)) {
    warnings.push("prefix.bindings must be a mapping of binding id to chord(s)")
    return out
  }
  for (const [id, raw] of Object.entries(source)) {
    if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
      out.set(id, [])
      continue
    }
    const rawKeys = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null
    if (!rawKeys || rawKeys.some((key) => typeof key !== "string")) {
      warnings.push(`prefix.bindings.${id} must be a chord string, a string list, null, or []`)
      continue
    }
    const keys: string[] = []
    for (const rawKey of rawKeys) {
      const normalized = normalizeChord(rawKey)
      if ("error" in normalized) {
        warnings.push(`prefix.bindings.${id}: ${normalized.error}`)
        continue
      }
      keys.push(normalized.chord)
      if (normalized.warning) warnings.push(`prefix.bindings.${id}: ${normalized.warning}`)
    }
    if (keys.length === rawKeys.length) out.set(id, keys)
  }
  return out
}

function mergePrefixBlock(
  raw: unknown,
  configuration: PrefixConfigurationOverride,
  entries: Map<string, string[]>,
  warnings: string[],
): void {
  if (raw === undefined) return
  if (!isRecord(raw)) {
    warnings.push("prefix must be a mapping")
    return
  }
  if ("key" in raw) {
    if (raw.key === null) configuration.key = null
    else if (typeof raw.key !== "string") warnings.push("prefix.key must be a modifier chord or null")
    else {
      const normalized = normalizeChord(raw.key)
      if ("error" in normalized) warnings.push(`prefix.key: ${normalized.error}`)
      else if (!normalized.chord.includes("+")) warnings.push("prefix.key must include a modifier")
      else configuration.key = normalized.chord
    }
  }
  if ("timeoutMs" in raw) {
    if (
      typeof raw.timeoutMs !== "number" ||
      !Number.isInteger(raw.timeoutMs) ||
      raw.timeoutMs < 100 ||
      raw.timeoutMs > 10000
    ) {
      warnings.push("prefix.timeoutMs must be an integer from 100 to 10000")
    } else configuration.timeoutMs = raw.timeoutMs
  }
  for (const [id, keys] of collectEntries(raw.bindings, warnings)) entries.set(id, keys)
}

/** Extract base prefix settings then apply one platform overlay. */
export function extractPrefixKeybindings(doc: unknown, platform: NodeJS.Platform): PrefixExtraction {
  const configuration: PrefixConfigurationOverride = {}
  const warnings: string[] = []
  const entries = new Map<string, string[]>()
  if (!isRecord(doc)) {
    if (doc !== null && doc !== undefined) warnings.push("keybindings document must be a mapping")
    return { configuration, entries: [], warnings }
  }
  mergePrefixBlock(doc.prefix, configuration, entries, warnings)
  for (const key of platformKeys(platform)) {
    const overlay = doc[key]
    if (isRecord(overlay)) mergePrefixBlock(overlay.prefix, configuration, entries, warnings)
  }
  return { configuration, entries: [...entries].map(([id, keys]) => ({ id, keys })), warnings }
}

/** Apply prefix second-stroke overrides alongside any direct chords. */
export function applyPrefixKeymapOverrides(
  keymap: readonly PrefixOverridableBinding[],
  entries: readonly KeymapOverrideEntry[],
): { applied: AppliedOverride[]; warnings: string[] } {
  const applied: AppliedOverride[] = []
  const warnings: string[] = []
  for (const entry of entries) {
    const row = keymap.find((candidate) => candidate.id === entry.id)
    if (!row) {
      warnings.push(`${entry.id}: unknown binding id`)
      continue
    }
    if (entry.id === "focus.numeric" && entry.keys.length !== 4) {
      warnings.push(`${entry.id}: needs exactly 4 prefix keys (sidebar, workspace, files, terminal)`)
      continue
    }
    const mutable = row as { prefixKeys?: readonly string[] }
    const defaultKeys = [...(row.prefixKeys ?? [])]
    mutable.prefixKeys = [...entry.keys]
    applied.push({ id: entry.id, keys: [...entry.keys], defaultKeys })
  }
  return { applied, warnings }
}
