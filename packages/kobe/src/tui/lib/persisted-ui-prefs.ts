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
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, hasBundledTheme } from "../context/theme-core"
import { DEFAULT_LOCALE, type LocaleId, isLocaleId } from "../i18n/catalog"

/** state.json key holding the persisted UI language. */
export const LOCALE_KEY = "locale"

export interface PersistedUiPrefs {
  /** Active theme name, validated against the registry (stale names fall back). */
  readonly theme: string
  readonly transparent: boolean
  readonly focusAccent: FocusAccentSlot | null
  /** Active UI language, validated against the registered locales. */
  readonly locale: LocaleId
  /** Accessibility: chrome animations degrade to calm forms. */
  readonly reducedMotion: boolean
}

/**
 * Read + validate the persisted prefs. Never throws — a missing /
 * malformed `state.json` yields the fallback theme with defaults off,
 * so a pane subcommand always renders.
 *
 * `isKnownTheme` decides whether a stored theme name still resolves. It
 * defaults to the bundled-only check, which is all an off-render caller can
 * answer on its own. A host that has already registered user themes (see
 * `bootPaneHost`, which calls `loadUserThemes()` first) must pass the live
 * registry's check instead — otherwise every `kobe theme add` theme is
 * treated as stale on the next boot and silently reverts to the fallback.
 */
export function readPersistedUiPrefs(
  fallbackTheme: string,
  isKnownTheme: (name: string) => boolean = hasBundledTheme,
): PersistedUiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const theme =
      typeof parsed.activeTheme === "string" && isKnownTheme(parsed.activeTheme) ? parsed.activeTheme : fallbackTheme
    // Default-true (2026-07-12): only an explicit stored `false` opts out.
    const transparent = parsed.transparentBackground !== false
    const focusAccent =
      typeof parsed.focusAccent === "string" && (FOCUS_ACCENT_SLOTS as readonly string[]).includes(parsed.focusAccent)
        ? (parsed.focusAccent as FocusAccentSlot)
        : null
    const locale = isLocaleId(parsed[LOCALE_KEY]) ? parsed[LOCALE_KEY] : DEFAULT_LOCALE
    const reducedMotion = parsed.reducedMotion === true
    return { theme, transparent, focusAccent, locale, reducedMotion }
  } catch {
    return { theme: fallbackTheme, transparent: true, focusAccent: null, locale: DEFAULT_LOCALE, reducedMotion: false }
  }
}
