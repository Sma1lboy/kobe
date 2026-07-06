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
