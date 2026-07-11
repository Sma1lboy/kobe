/**
 * Framework-free keymap DISPLAY seam (issue #15, G3): grouping for the help
 * dialog plus the chord-cap resolution the Tasks-pane footer legend and the
 * help dialog share. `groupBindings` stays generic over the `category`
 * field; the cap helpers read the real keymap via `findBinding` (itself
 * framework-free and vitest-safe — tests import both directly).
 */

import type { KobeBinding } from "../context/keybindings"
import { findBinding } from "../context/keybindings"

/** Group a flat keymap into categories in declaration order. */
export function groupBindings<T extends { readonly category: string }>(
  keymap: readonly T[],
): { category: string; rows: readonly T[] }[] {
  const grouped: { category: string; rows: T[] }[] = []
  const index = new Map<string, T[]>()
  for (const b of keymap) {
    let rows = index.get(b.category)
    if (!rows) {
      rows = []
      index.set(b.category, rows)
      grouped.push({ category: b.category, rows })
    }
    rows.push(b)
  }
  return grouped
}

/**
 * The chord cap a keymap row advertises: the cosmetic `hint.keys` when
 * present (it's refreshed in place on an override — keymap-overrides.ts),
 * else the canonical first chord; `undefined` when the row has neither.
 */
export function capOf(row: Pick<KobeBinding, "keys" | "hint">): string | undefined {
  return row.hint?.keys ?? row.keys[0]
}

/**
 * Resolve a single binding id to the chord cap a legend should advertise
 * ({@link capOf}). Returns `null` when the id is unknown or unbound (no
 * chords) — the row that owns it should then drop, since advertising a dead
 * chord is worse than none (mirrors the override path that nulls a hint on
 * unbind).
 */
export function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = capOf(row)
  return cap && cap.length > 0 ? cap : null
}

/**
 * Resolve a (possibly composite) legend row's keycap from the binding ids it
 * represents. Each id contributes its {@link legendCap}; unbound ids drop out
 * and the survivors join with `/` (so `r/b/v` becomes `r/v` if `b` is
 * unbound, or the whole row drops when nothing survives). Returns `null` when
 * every id resolved to no chord — the caller drops the row entirely.
 */
export function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}
