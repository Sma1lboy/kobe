/**
 * Live theme application + precedence.
 *
 * The bridge serves the TUI's theme JSONs resolved into the web's `--color-*`
 * token vocabulary (GET /api/themes). Two inputs can pick the active theme:
 *
 *   - the daemon's `ui-prefs` channel (the TUI's chosen theme), and
 *   - a web-local override the user picks in Settings (localStorage).
 *
 * Precedence: a web-local override WINS over ui-prefs (the user explicitly
 * chose a theme for this browser); clearing it falls back to following the
 * TUI. Applying overrides the Tailwind v4 theme variables on `:root`, which
 * restyles every utility class live — styles.css's static claude values stay
 * as the first-paint fallback.
 *
 * xterm can't read CSS variables, so terminals ask for the active palette via
 * `xtermTheme()` at mount; already-open terminals keep their palette until
 * re-created (theme switches are rare).
 */

import { useSyncExternalStore } from "react"

export type WebThemePalette = Record<string, string>

const FALLBACK_THEME = "claude"
const OVERRIDE_KEY = "kobe-web.theme"

let palettes: Record<string, WebThemePalette> | null = null
let appliedTheme: string | null = null
let userTheme: string | null = readOverride()
let prefsTheme: string | null = null
let fetched = false
const listeners = new Set<() => void>()

function readOverride(): string | null {
  try {
    return localStorage.getItem(OVERRIDE_KEY)
  } catch {
    return null
  }
}

function notify(): void {
  for (const l of listeners) l()
}

/** The theme that SHOULD be showing: web-local override, else TUI prefs,
 *  else the fallback. */
function effectiveTheme(): string {
  return userTheme ?? prefsTheme ?? FALLBACK_THEME
}

function ensureFetched(): void {
  if (fetched) return
  fetched = true
  void fetch("/api/themes")
    .then(async (res) => {
      if (!res.ok) return
      const json = (await res.json()) as {
        themes?: Record<string, WebThemePalette>
      }
      if (!json.themes) return
      palettes = json.themes
      paint() // replay whatever the effective theme is now that we have data
      notify()
    })
    .catch(() => {
      /* static claude tokens remain */
    })
}

/** Write the effective palette onto :root (no-op until palettes load). */
function paint(): void {
  ensureFetched()
  if (!palettes) return
  const name = effectiveTheme()
  if (appliedTheme === name) return
  const palette = palettes[name] ?? palettes[FALLBACK_THEME]
  if (!palette) return
  appliedTheme = name
  const root = document.documentElement
  for (const [token, value] of Object.entries(palette)) {
    root.style.setProperty(`--color-${token}`, value)
  }
  notify()
}

/** Called by the store when the daemon pushes `ui-prefs`. Follows the TUI
 *  unless the user has set a web-local override. */
export function applyThemeFromPrefs(name: string): void {
  prefsTheme = name
  paint()
}

/** Set a web-local theme override (Settings picker) — wins over ui-prefs. */
export function setPreferredTheme(name: string): void {
  userTheme = name
  try {
    localStorage.setItem(OVERRIDE_KEY, name)
  } catch {
    /* ignore */
  }
  paint()
}

/** Clear the web-local override → follow the TUI's theme again. */
export function clearPreferredTheme(): void {
  userTheme = null
  try {
    localStorage.removeItem(OVERRIDE_KEY)
  } catch {
    /* ignore */
  }
  appliedTheme = null // force a repaint to the now-effective theme
  paint()
}

export interface ThemeState {
  /** Theme names available (empty until /api/themes loads). */
  names: string[]
  /** Palette map for swatch previews. */
  palettes: Record<string, WebThemePalette>
  /** The theme currently painted. */
  active: string
  /** True when a web-local override is in effect (vs following the TUI). */
  overridden: boolean
}

function snapshotState(): ThemeState {
  return {
    names: palettes ? Object.keys(palettes) : [],
    palettes: palettes ?? {},
    active: effectiveTheme(),
    overridden: userTheme !== null,
  }
}

let cachedSnapshot: ThemeState = snapshotState()
function getSnapshot(): ThemeState {
  // useSyncExternalStore needs a stable reference between notifies.
  const next = snapshotState()
  if (
    next.active !== cachedSnapshot.active ||
    next.overridden !== cachedSnapshot.overridden ||
    next.names.length !== cachedSnapshot.names.length
  ) {
    cachedSnapshot = next
  }
  return cachedSnapshot
}

/** React hook for the Settings theme picker. */
export function useThemeState(): ThemeState {
  ensureFetched()
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot,
    getSnapshot,
  )
}

// Apply the persisted override immediately at module load (first paint).
paint()

/** The active palette (post-apply), or null while on the static fallback. */
export function activePalette(): WebThemePalette | null {
  if (!palettes) return null
  return palettes[effectiveTheme()] ?? null
}

/** Build an xterm theme object from the active palette; null = use the
 *  caller's static default. */
export function xtermTheme(): Record<string, string> | null {
  const p = activePalette()
  if (!p) return null
  return {
    background: p.bg,
    foreground: p.fg,
    cursor: p.primary,
    cursorAccent: p.bg,
    selectionBackground: p.menu,
    black: p.bg,
    red: p["kobe-red"],
    green: p["kobe-green"],
    yellow: p["kobe-yellow"],
    blue: p["kobe-blue"],
    magenta: p["kobe-violet"],
    cyan: p["primary-hover"],
    white: p.muted,
    brightBlack: p.subtle,
    brightRed: p["kobe-red"],
    brightGreen: p["kobe-green"],
    brightYellow: p["kobe-yellow"],
    brightBlue: p["kobe-blue"],
    brightMagenta: p["kobe-violet"],
    brightCyan: p["primary-hover"],
    brightWhite: p.fg,
  }
}
