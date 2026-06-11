/**
 * Live theme application — keeps the web dashboard on the SAME theme as the
 * TUI. The bridge serves the TUI's 7 theme JSONs resolved into the web's
 * `--color-*` token vocabulary (GET /api/themes); the daemon's `ui-prefs`
 * channel says which one is active. Applying a theme overrides the Tailwind
 * v4 theme variables on `:root`, which restyles every utility class live —
 * styles.css's static claude values stay as the first-paint fallback.
 *
 * xterm can't read CSS variables, so terminals ask for the active palette
 * via `xtermTheme()` at mount; already-open terminals keep their palette
 * until re-created (theme switches are rare; re-painting a live PTY scrolls
 * its buffer for marginal gain).
 */

export type WebThemePalette = Record<string, string>

const FALLBACK_THEME = "claude"

let palettes: Record<string, WebThemePalette> | null = null
let pendingTheme: string | null = null
let appliedTheme: string | null = null
let fetched = false

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
      if (pendingTheme) {
        const name = pendingTheme
        pendingTheme = null
        applyTheme(name)
      }
    })
    .catch(() => {
      /* static claude tokens remain */
    })
}

/** Apply a named theme's palette onto :root. Unknown names fall back to
 *  claude; calls before the palette fetch lands are replayed after it. */
export function applyTheme(name: string): void {
  ensureFetched()
  if (!palettes) {
    pendingTheme = name
    return
  }
  if (appliedTheme === name) return
  const palette = palettes[name] ?? palettes[FALLBACK_THEME]
  if (!palette) return
  appliedTheme = name
  const root = document.documentElement
  for (const [token, value] of Object.entries(palette)) {
    root.style.setProperty(`--color-${token}`, value)
  }
}

/** The active palette (post-apply), or null while on the static fallback. */
export function activePalette(): WebThemePalette | null {
  if (!palettes) return null
  return palettes[appliedTheme ?? FALLBACK_THEME] ?? null
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
