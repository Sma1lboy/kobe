/**
 * Read the UI prefs the outer kobe TUI persisted to `state.json`.
 *
 * A kobe subcommand that renders in a tmux pane (the Ops pane today,
 * a full-width preview window soon) wants to match the outer app's
 * look: same theme, transparent-bg toggle, focus accent. It can't
 * share the outer TUI's Solid runtime (separate process), so it reads
 * the persisted prefs off disk instead.
 *
 * READ-ONLY by contract: the outer app owns `state.json`; a pane
 * subprocess writing it would race the main process. This module only
 * reads. (The KV store at `tui/context/kv.tsx` is the writer.)
 */

import { readFileSync } from "node:fs"
import { kvStatePath } from "../../env.ts"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, hasTheme } from "../context/theme"

export interface PersistedUiPrefs {
  /** Active theme name, validated against the registry (stale names fall back). */
  readonly theme: string
  readonly transparent: boolean
  readonly focusAccent: FocusAccentSlot | null
}

/**
 * Read + validate the persisted prefs. Never throws — a missing /
 * malformed `state.json` yields the fallback theme with defaults off,
 * so a pane subcommand always renders.
 */
export function readPersistedUiPrefs(fallbackTheme: string): PersistedUiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const theme =
      typeof parsed.activeTheme === "string" && hasTheme(parsed.activeTheme) ? parsed.activeTheme : fallbackTheme
    const transparent = parsed.transparentBackground === true
    const focusAccent =
      typeof parsed.focusAccent === "string" && (FOCUS_ACCENT_SLOTS as readonly string[]).includes(parsed.focusAccent)
        ? (parsed.focusAccent as FocusAccentSlot)
        : null
    return { theme, transparent, focusAccent }
  } catch {
    return { theme: fallbackTheme, transparent: false, focusAccent: null }
  }
}
