/**
 * Framework-free keymap DISPLAY seam (issue #15, G3): grouping for the help
 * dialog plus the chord-cap resolution the Tasks-pane footer legend and the
 * help dialog share. `groupBindings` stays generic over the `category`
 * field; the cap helpers read the real keymap via `findBinding` (itself
 * framework-free and vitest-safe — tests import both directly).
 */

import type { KobeBinding, KobeBindingScope } from "../context/keybindings"
import { findBinding } from "../context/keybindings"
import type { BindingReachability } from "./keymap-dispatch"

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

export type HelpSurface = Exclude<KobeBindingScope, "global" | "inbox">
export type HelpGrammarKind = "here" | "direct" | "prefix" | "other"
export type HelpGrammarRow = {
  binding: KobeBinding
  primary: string
  aliases: readonly string[]
}
export type HelpGrammarSection = {
  kind: HelpGrammarKind
  scope?: KobeBindingScope
  rows: readonly HelpGrammarRow[]
}

function directCap(row: KobeBinding): string | null {
  if (row.keys.length > 0) return row.hint?.keys ?? row.keys[0] ?? null
  // Documentation-only rows (composer and diff keys) still describe a
  // direct, surface-owned gesture through their friendly hint.
  return row.prefixKeys?.length ? null : (row.hint?.keys ?? null)
}

function availableOn(row: KobeBinding, surface: HelpSurface | null): boolean {
  if (row.scope === "global") return true
  if (surface === null) return false
  if (row.scope === surface) return true
  // Terminal is the workspace's embedded input surface. Workspace-owned
  // reserved direct chords stay relevant there; prefix rows are filtered by
  // the caller because the prefix key itself passes through to the PTY.
  return surface === "terminal" && row.scope === "workspace"
}

/**
 * Reframe the catalogue around the user's input grammar: keys in the focused
 * surface, one-press Kobe shortcuts, then commands behind the configured
 * prefix. Remaining pane-local rows follow as reference instead of being
 * mixed into the primary list.
 */
export function grammarHelpSections(
  keymap: readonly KobeBinding[],
  surface: HelpSurface | null,
  prefixKey: string | null,
  reachability?: BindingReachability,
): HelpGrammarSection[] {
  const here: HelpGrammarRow[] = []
  const direct: HelpGrammarRow[] = []
  const prefix: HelpGrammarRow[] = []
  const other = new Map<KobeBindingScope, HelpGrammarRow[]>()

  for (const binding of keymap) {
    const cap = directCap(binding)
    const staticallyAvailable = availableOn(binding, surface)
    const directAvailable = reachability ? reachability.direct.has(binding.id) : staticallyAvailable
    const prefixAvailable = reachability ? reachability.prefix.has(binding.id) : staticallyAvailable
    if (cap) {
      const row = { binding, primary: cap, aliases: binding.keys.filter((key) => key !== cap) }
      const docOnlyHere = binding.keys.length === 0 && !binding.prefixKeys?.length && staticallyAvailable
      if ((directAvailable && (staticallyAvailable || binding.presentation === "onePress")) || docOnlyHere) {
        if (binding.presentation === "onePress") direct.push(row)
        else here.push(row)
      } else if (binding.scope !== "global") {
        const rows = other.get(binding.scope)
        if (rows) rows.push(row)
        else other.set(binding.scope, [row])
      }
    }
    if (prefixKey && surface !== "terminal" && prefixAvailable && binding.prefixKeys?.length) {
      prefix.push({
        binding,
        primary: `${prefixKey} + ${binding.prefixKeys[0]}`,
        aliases: binding.prefixKeys.slice(1).map((key) => `${prefixKey} + ${key}`),
      })
    }
  }

  const sections: HelpGrammarSection[] = []
  if (here.length) sections.push({ kind: "here", scope: surface ?? undefined, rows: here })
  if (direct.length) sections.push({ kind: "direct", rows: direct })
  if (prefix.length) sections.push({ kind: "prefix", rows: prefix })
  for (const [scope, rows] of other) sections.push({ kind: "other", scope, rows })
  return sections
}
