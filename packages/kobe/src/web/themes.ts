/**
 * Theme palettes for the web dashboard — the same 7 theme JSONs the TUI
 * ships (tui/context/theme/*.json), resolved to flat hex palettes in the
 * web's token vocabulary (the `--color-*` custom properties in
 * packages/kobe-web/src/styles.css). One source of truth for brand colors:
 * a TUI theme switch fans out over the daemon's `ui-prefs` channel and the
 * web applies the matching palette live.
 *
 * The def-ref resolution mirrors `tui/context/theme.tsx` `resolveTheme`
 * (hex / def-name / {dark,light} variant) but emits hex strings instead of
 * opentui RGBA — the web can't import @opentui/core.
 *
 * Route:  GET /api/themes → { themes: Record<name, WebThemePalette> }
 */

import claude from "../tui/context/theme/claude.json" with { type: "json" }
import conductor from "../tui/context/theme/conductor.json" with { type: "json" }
import dracula from "../tui/context/theme/dracula.json" with { type: "json" }
import nord from "../tui/context/theme/nord.json" with { type: "json" }
import opencode from "../tui/context/theme/opencode.json" with { type: "json" }
import osakaJade from "../tui/context/theme/osaka-jade.json" with { type: "json" }
import tokyonight from "../tui/context/theme/tokyonight.json" with { type: "json" }

type Variant = { dark: string; light: string }
type ColorValue = string | Variant

interface ThemeJson {
  defs?: Record<string, string>
  theme: Record<string, ColorValue>
}

/** The web token vocabulary — keys match styles.css `--color-<key>`. */
export interface WebThemePalette {
  bg: string
  surface: string
  inset: string
  menu: string
  line: string
  "line-subtle": string
  "line-active": string
  fg: string
  muted: string
  subtle: string
  primary: string
  "primary-hover": string
  "kobe-orange": string
  "kobe-green": string
  "kobe-blue": string
  "kobe-red": string
  "kobe-yellow": string
  "kobe-violet": string
}

const THEME_JSONS: Record<string, ThemeJson> = {
  claude: claude as ThemeJson,
  conductor: conductor as ThemeJson,
  dracula: dracula as ThemeJson,
  nord: nord as ThemeJson,
  opencode: opencode as ThemeJson,
  "osaka-jade": osakaJade as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
}

function resolveHex(themeJson: ThemeJson, value: ColorValue | undefined, chain: string[] = []): string | null {
  if (value === undefined) return null
  if (typeof value !== "string") return resolveHex(themeJson, value.dark, chain)
  if (value === "transparent" || value === "none") return null
  if (value.startsWith("#")) return value
  if (chain.includes(value)) return null
  const next = themeJson.defs?.[value] ?? themeJson.theme[value]
  return resolveHex(themeJson, next, [...chain, value])
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

/** Blend `a` toward `b` by `t` (0..1) — for derived slots the theme JSONs
 *  don't carry (subtle text, hover states). */
function mix(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const ch = (p: number, shift: number): number => (p >> shift) & 0xff
  const out =
    (clampByte(ch(pa, 16) + (ch(pb, 16) - ch(pa, 16)) * t) << 16) |
    (clampByte(ch(pa, 8) + (ch(pb, 8) - ch(pa, 8)) * t) << 8) |
    clampByte(ch(pa, 0) + (ch(pb, 0) - ch(pa, 0)) * t)
  return `#${out.toString(16).padStart(6, "0")}`
}

function toWebPalette(themeJson: ThemeJson): WebThemePalette | null {
  const slot = (name: string): string | null => resolveHex(themeJson, themeJson.theme[name])
  const bg = slot("background")
  const fg = slot("text")
  if (!bg || !fg) return null
  const muted = slot("textMuted") ?? mix(fg, bg, 0.35)
  const primary = slot("primary") ?? fg
  const line = slot("border") ?? mix(fg, bg, 0.8)
  return {
    bg,
    surface: slot("backgroundPanel") ?? bg,
    inset: slot("backgroundElement") ?? bg,
    menu: slot("backgroundMenu") ?? slot("backgroundElement") ?? bg,
    line,
    "line-subtle": slot("borderSubtle") ?? line,
    "line-active": slot("borderActive") ?? mix(line, fg, 0.3),
    fg,
    muted,
    // No textSubtle slot in the theme schema — derive by sinking muted
    // toward the background (matches the static claude values closely).
    subtle: mix(muted, bg, 0.35),
    primary,
    "primary-hover": mix(primary, fg, 0.35),
    "kobe-orange": primary,
    "kobe-green": slot("success") ?? fg,
    "kobe-blue": slot("info") ?? fg,
    "kobe-red": slot("error") ?? fg,
    "kobe-yellow": slot("warning") ?? fg,
    "kobe-violet": slot("secondary") ?? primary,
  }
}

/** Resolved once at module load — theme JSONs are static imports. */
export const WEB_THEMES: Record<string, WebThemePalette> = Object.fromEntries(
  Object.entries(THEME_JSONS)
    .map(([name, json]) => [name, toWebPalette(json)] as const)
    .filter((entry): entry is [string, WebThemePalette] => entry[1] !== null),
)

const THEMES_ROUTE = "/api/themes"

/** Route handler; `null` when not a themes route so the caller falls through. */
export function handleThemesRequest(req: Request, url: URL): Response | null {
  if (url.pathname !== THEMES_ROUTE) return null
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
  return Response.json({ themes: WEB_THEMES })
}
