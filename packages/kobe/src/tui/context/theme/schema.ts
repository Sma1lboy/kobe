/**
 * Hand-rolled runtime validator for `ThemeJson` — the on-disk shape kobe
 * expects from both bundled themes (under `src/tui/context/theme/*.json`)
 * and user-installed themes (`~/.kobe/themes/*.json`).
 *
 * Why hand-rolled and not zod / valibot / etc.: nothing in
 * `src/tui/context/` currently pulls in a runtime validator, and the
 * shape is small enough (~10 rules) that a 70-line check is cheaper than
 * adding a dependency. If we ever introduce zod elsewhere, swap this
 * implementation — the public surface (`validateTheme`) is intentionally
 * tiny so callers don't have to care.
 *
 * What we validate:
 *   - top level is an object (not null, not array, not primitive).
 *   - `theme` key is required and is a record.
 *   - `defs` key is optional; when present, every value must be a string.
 *   - every theme entry value is either a string (hex or def-ref) OR
 *     a `{ dark, light }` variant object whose both fields are strings.
 *
 * What we deliberately don't enforce:
 *   - Required slot presence (no "must have `text` and `background`").
 *     The existing `resolveTheme` falls back gracefully via the fallback
 *     chain in theme.tsx, so a sparse user theme that overrides only a
 *     couple of slots is a feature, not an error.
 *   - Hex format on bare strings. A bare string that doesn't match
 *     `^#…$` is treated as a def-name reference. Names that don't
 *     resolve get collapsed to black at render time (theme.tsx's
 *     `resolve()` returns `RGBA.fromInts(0,0,0)` for unresolvable
 *     refs). Refusing them here would force users to predeclare every
 *     def-name, which is more rigid than the runtime needs.
 *   - `$schema` URL. We accept any string (or its absence). The schema
 *     pointer is purely for editor autocomplete, not runtime semantics.
 */

import type { ThemeJson } from "../theme"

/** Hex strings: 3, 6, or 8 hex digits after `#`. */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export type ValidateResult = { ok: true; theme: ThemeJson } | { ok: false; reason: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True if `s` is `#abc`, `#aabbcc`, or `#aabbccdd`. */
export function isHex(s: string): boolean {
  return HEX_RE.test(s)
}

/**
 * Validate a parsed JSON value as a `ThemeJson`. Returns a discriminated
 * union so callers can branch on `ok` and surface a useful one-line
 * reason on rejection (used by both the disk loader's `console.warn`
 * and the CLI's `kobe theme add` error path).
 */
export function validateTheme(value: unknown): ValidateResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "theme must be a JSON object at the top level" }
  }
  const obj = value as Record<string, unknown>

  // `theme` — required, must be an object map of slot -> value.
  if (!("theme" in obj)) {
    return { ok: false, reason: "missing required key `theme`" }
  }
  const theme = obj.theme
  if (!isPlainObject(theme)) {
    return { ok: false, reason: "`theme` must be an object map" }
  }

  // `defs` — optional, but when present every value must be a string.
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

  // Every theme entry value: string (hex / ref) OR { dark, light } variant.
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
    // Reject extra keys silently? No — accept them so future kobe
    // versions can introduce optional variants (e.g. `highContrast`)
    // without breaking older binaries that don't know about them.
  }

  // `$schema` — optional informational pointer, only used by editors.
  if ("$schema" in obj && obj.$schema !== undefined && typeof obj.$schema !== "string") {
    return { ok: false, reason: "`$schema` must be a string when present" }
  }

  return { ok: true, theme: obj as unknown as ThemeJson }
}
