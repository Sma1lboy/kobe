import type { ThemeJson } from "../theme"

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export type ValidateResult = { ok: true; theme: ThemeJson } | { ok: false; reason: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function isHex(s: string): boolean {
  return HEX_RE.test(s)
}

export function validateTheme(value: unknown): ValidateResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "theme must be a JSON object at the top level" }
  }
  const obj = value as Record<string, unknown>

  if (!("theme" in obj)) {
    return { ok: false, reason: "missing required key `theme`" }
  }
  const theme = obj.theme
  if (!isPlainObject(theme)) {
    return { ok: false, reason: "`theme` must be an object map" }
  }

  if ("defs" in obj && obj.defs !== undefined) {
    if (!isPlainObject(obj.defs)) {
      return { ok: false, reason: "`defs` must be an object map" }
    }
    for (const [k, v] of Object.entries(obj.defs)) {
      if (typeof v !== "string") {
        return { ok: false, reason: `defs.${k} must be a string (hex like \"#abc\" or a ref name)` }
      }
    }
  }

  for (const [slot, raw] of Object.entries(theme)) {
    if (typeof raw === "string") continue
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        reason: `theme.${slot} must be a string or a { dark, light } object (got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw})`,
      }
    }
    const variant = raw as Record<string, unknown>
    if (typeof variant.dark !== "string") {
      return { ok: false, reason: `theme.${slot}.dark must be a string` }
    }
    if (typeof variant.light !== "string") {
      return { ok: false, reason: `theme.${slot}.light must be a string` }
    }
  }

  if ("$schema" in obj && obj.$schema !== undefined && typeof obj.$schema !== "string") {
    return { ok: false, reason: "`$schema` must be a string when present" }
  }

  return { ok: true, theme: obj as unknown as ThemeJson }
}
