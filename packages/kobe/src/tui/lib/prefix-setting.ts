import { normalizeChord } from "./keymap-overrides"

export type PrefixInputResult = { key: string | null } | { error: string }

/** Validate the Settings text field using the same chord grammar as YAML. */
export function normalizePrefixInput(raw: string): PrefixInputResult {
  const value = raw.trim()
  if (["disabled", "none", "null"].includes(value.toLowerCase())) return { key: null }
  const normalized = normalizeChord(value)
  if ("error" in normalized) return { error: normalized.error }
  if (!normalized.chord.includes("+")) return { error: "Prefix keys must include a modifier (for example ctrl+b)." }
  return { key: normalized.chord }
}
