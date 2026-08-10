/**
 * Framework-free assembly for the keyboard-discoverability hints (the
 * status-bar micro-hint and the first-use pane hints). This module decides
 * WHAT a hint says; the React components in
 * `tui-react/component/keyboard-hints.tsx` decide where it renders.
 *
 * Contract (docs/KEYBINDINGS.md): every advertised chord resolves through
 * the LIVE keymap (`legendCap`) and the live reachability snapshot, so a
 * rebound chord shows its new key and an unbound/unreachable one drops out
 * instead of teaching a dead key.
 */

import { formatChord } from "./chord-glyphs"
import { legendCap } from "./help-groups"
import type { BindingReachability } from "./keymap-dispatch"

/** Master toggle (Settings → General → Keyboard hints). Default ON. */
export const KEY_HINTS_ENABLED_KEY = "hints.keyboard.enabled"

/** Per-pane "the user has used this pane's keys" flags — set once, never nagged again. */
export const PANE_HINT_USED_KEYS = {
  sidebar: "hints.sidebar.used",
  files: "hints.files.used",
} as const

export type HintPane = keyof typeof PANE_HINT_USED_KEYS

/** True unless the user explicitly turned hints off (raw KV value). */
export function keyHintsEnabled(raw: unknown): boolean {
  return raw !== false
}

/** The get/set slice of the UI KV store these helpers need (KVContext-shaped). */
export type HintKvLike = {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

/** Settings toggle read: whether the hint surfaces are enabled. */
export function keyHintsToggleOn(kv: HintKvLike): boolean {
  return keyHintsEnabled(kv.get(KEY_HINTS_ENABLED_KEY, true))
}

/**
 * Settings toggle write. Re-enabling also relights pane hints already
 * extinguished by use — that is the "show me the hints again" gesture.
 */
export function toggleKeyHints(kv: HintKvLike): void {
  const next = !keyHintsToggleOn(kv)
  kv.set(KEY_HINTS_ENABLED_KEY, next)
  if (next) for (const key of Object.values(PANE_HINT_USED_KEYS)) kv.set(key, false)
}

/** True while a pane's first-use hint should still show (raw KV values). */
export function paneHintVisible(enabledRaw: unknown, usedRaw: unknown): boolean {
  return keyHintsEnabled(enabledRaw) && usedRaw !== true
}

export type StatusHintToken = {
  /** Machine chord for display formatting (`formatChord`). */
  chord: string
  /** `hints.status.*` message key filled with the formatted chord. */
  msg: "commands" | "sidebar" | "help"
}

/**
 * The status-bar micro-hint, derived from the live reachability snapshot:
 * the configured prefix remains Kobe-owned inside the embedded terminal, so
 * it stays visible whenever a second stroke can run. If no prefix command is
 * reachable there, the escape hatch is the truthful fallback; a disabled
 * prefix or unbound help chord drops its token.
 */
export function statusHintTokens(reach: BindingReachability, prefixKey: string | null): StatusHintToken[] {
  const tokens: StatusHintToken[] = []
  if (prefixKey !== null && reach.prefix.size > 0) {
    tokens.push({ chord: prefixKey, msg: "commands" })
  } else if (reach.inputPassthrough) {
    const cap = reach.direct.has("focus.sidebar") ? legendCap("focus.sidebar") : null
    if (cap) tokens.push({ chord: cap, msg: "sidebar" })
  }
  if (reach.direct.has("help.open")) {
    const cap = legendCap("help.open")
    if (cap) tokens.push({ chord: cap, msg: "help" })
  }
  return tokens
}

export type PaneHintToken = {
  /** Live chord cap from the keymap row (`legendCap`). */
  cap: string
  /** `hints.pane.*` message key for the verb after the cap. */
  msg: string
}

/**
 * What each pane's hint line teaches. `always: true` rows survive past the
 * first-use window as the pane's permanent short footer (today only the
 * files pane keeps one — its pre-existing `↵ open · d diff` line, now live).
 */
const PANE_HINT_ROWS: Record<HintPane, readonly { id: string; msg: string; always?: true }[]> = {
  // Two tokens only: the line must fit the narrow sidebar rail (clipping a
  // teaching line mid-word is worse than teaching less — F1 has the rest).
  sidebar: [
    { id: "sidebar.nav", msg: "move" },
    { id: "sidebar.select", msg: "open" },
  ],
  files: [
    { id: "files.nav", msg: "move" },
    { id: "files.hierarchy", msg: "fold" },
    { id: "files.open", msg: "open", always: true },
    { id: "files.diff", msg: "diff", always: true },
  ],
}

/** Resolve a pane's hint tokens from the live keymap; unbound rows drop. */
export function paneHintTokens(pane: HintPane, mode: "firstUse" | "always"): PaneHintToken[] {
  return PANE_HINT_ROWS[pane].flatMap((row) => {
    if (mode === "always" && row.always !== true) return []
    const cap = legendCap(row.id)
    return cap ? [{ cap, msg: row.msg }] : []
  })
}

export type WizardKeyLine = {
  /** `onboarding.keys*` message key. */
  msg: "keysBare" | "keysOnePress" | "keysPrefix" | "keysHelp"
  params: Record<string, string>
}

/**
 * The first-run wizard's "Keyboard basics" lines, resolved from the live
 * keymap so a rebound/disabled chord is never taught. A line whose example
 * bindings are unbound drops out entirely.
 */
export function wizardKeyLines(prefixKey: string | null): WizardKeyLine[] {
  const lines: WizardKeyLine[] = []
  const nav = legendCap("sidebar.nav")
  const open = legendCap("sidebar.select")
  if (nav && open) lines.push({ msg: "keysBare", params: { nav: formatChord(nav), open: formatChord(open) } })
  const newTab = legendCap("chat.tab.new")
  const focusNext = legendCap("focus.next")
  if (newTab && focusNext)
    lines.push({ msg: "keysOnePress", params: { newTab: formatChord(newTab), focusNext: formatChord(focusNext) } })
  if (prefixKey !== null) lines.push({ msg: "keysPrefix", params: { prefix: formatChord(prefixKey) } })
  const help = legendCap("help.open")
  if (help) lines.push({ msg: "keysHelp", params: { help: formatChord(help) } })
  return lines
}
