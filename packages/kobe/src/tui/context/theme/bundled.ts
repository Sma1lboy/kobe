/**
 * The bundled theme JSONs as a plain map — the SINGLE owner of the static
 * JSON imports. `theme-core.ts` re-exports this map as `BUNDLED_THEMES`
 * for the theme providers; off-render callers (e.g. resolving tmux border
 * colors at session-build time) import it here directly. `cli/theme.ts`
 * mirrors just the NAMES — keep `BUNDLED_NAMES` there in sync with the
 * keys of this map.
 */

import type { ThemeJson } from "../theme-core"

import claude from "./claude.json" with { type: "json" }
import conductor from "./conductor.json" with { type: "json" }
import dracula from "./dracula.json" with { type: "json" }
import nord from "./nord.json" with { type: "json" }
import opencode from "./opencode.json" with { type: "json" }
import osakaJade from "./osaka-jade.json" with { type: "json" }
import tokyonight from "./tokyonight.json" with { type: "json" }

export const BUNDLED_THEME_JSONS: Record<string, ThemeJson> = {
  // Claude-branded palette (terracotta accent on warm neutrals), ported
  // from ashwingopalsamy/claude-code-theme's brandTokens. Default for
  // new kobe installs so the TUI reads as part of the Claude ecosystem.
  claude: claude as ThemeJson,
  conductor: conductor as ThemeJson,
  nord: nord as ThemeJson,
  opencode: opencode as ThemeJson,
  dracula: dracula as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
  "osaka-jade": osakaJade as ThemeJson,
}
