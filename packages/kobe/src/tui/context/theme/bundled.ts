/**
 * The bundled theme JSONs as a plain map, importable WITHOUT the Solid
 * runtime.
 *
 * `theme.tsx` keeps its own static imports (it needs them inside a Solid
 * store built at module load), and `cli/theme.ts` mirrors just the NAMES
 * for the same reason. This module is for code that needs the actual
 * JSON payloads outside the TUI runtime — e.g. resolving tmux border
 * colors at session-build time. Keep the set in sync with
 * `BUNDLED_THEMES` in `theme.tsx` and `BUNDLED_NAMES` in `cli/theme.ts`.
 */

import type { ThemeJson } from "../theme"

import claude from "./claude.json" with { type: "json" }
import conductor from "./conductor.json" with { type: "json" }
import dracula from "./dracula.json" with { type: "json" }
import nord from "./nord.json" with { type: "json" }
import opencode from "./opencode.json" with { type: "json" }
import osakaJade from "./osaka-jade.json" with { type: "json" }
import tokyonight from "./tokyonight.json" with { type: "json" }

export const BUNDLED_THEME_JSONS: Record<string, ThemeJson> = {
  claude: claude as ThemeJson,
  conductor: conductor as ThemeJson,
  nord: nord as ThemeJson,
  opencode: opencode as ThemeJson,
  dracula: dracula as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
  "osaka-jade": osakaJade as ThemeJson,
}
