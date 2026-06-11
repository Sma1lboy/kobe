import { describe, expect, it } from "vitest"
import { WEB_THEMES, type WebThemePalette, handleThemesRequest } from "../../src/web/themes.ts"

/**
 * The web theme palettes are resolved at module load from the TUI's theme
 * JSONs (def-ref resolution + derived slots). The dashboard restyles by
 * setting `--color-<key>` for every key, so a palette missing a key or
 * carrying a non-hex value would break theming. Lock the contract.
 */

// Every token the web's styles.css `@theme` block declares — the SPA's
// applyTheme sets `--color-<key>` for each, so each must be present + valid.
const REQUIRED_KEYS: (keyof WebThemePalette)[] = [
  "bg",
  "surface",
  "inset",
  "menu",
  "line",
  "line-subtle",
  "line-active",
  "fg",
  "muted",
  "subtle",
  "primary",
  "primary-hover",
  "kobe-orange",
  "kobe-green",
  "kobe-blue",
  "kobe-red",
  "kobe-yellow",
  "kobe-violet",
]

const HEX = /^#[0-9a-fA-F]{6}$/

describe("WEB_THEMES", () => {
  it("ships all 7 bundled themes", () => {
    expect(Object.keys(WEB_THEMES).sort()).toEqual(
      ["claude", "conductor", "dracula", "nord", "opencode", "osaka-jade", "tokyonight"].sort(),
    )
  })

  it("every theme has every required token, all valid 6-digit hex", () => {
    for (const [name, palette] of Object.entries(WEB_THEMES)) {
      for (const key of REQUIRED_KEYS) {
        const value = palette[key]
        expect(value, `${name}.${key}`).toBeTruthy()
        expect(value, `${name}.${key} = ${value}`).toMatch(HEX)
      }
    }
  })

  it("resolves claude to its canonical dark values (def-ref chain works)", () => {
    // claude.json: background → darkBg #141413, text → darkText #EAE7DF,
    // primary → darkPrimary #CC785C. Confirms def-name → hex resolution.
    expect(WEB_THEMES.claude.bg.toLowerCase()).toBe("#141413")
    expect(WEB_THEMES.claude.fg.toLowerCase()).toBe("#eae7df")
    expect(WEB_THEMES.claude.primary.toLowerCase()).toBe("#cc785c")
  })

  it("derives distinct surface tones (bg != surface != inset for a layered theme)", () => {
    // claude has separate raised/inset surfaces — the dark-theme depth rule.
    const p = WEB_THEMES.claude
    expect(p.bg).not.toBe(p.surface)
    expect(p.surface).not.toBe(p.inset)
  })
})

describe("handleThemesRequest", () => {
  it("returns null for a non-themes path (falls through)", () => {
    const url = new URL("http://localhost/api/diff")
    expect(handleThemesRequest(new Request(url), url)).toBeNull()
  })

  it("serves the palettes on GET /api/themes", async () => {
    const url = new URL("http://localhost/api/themes")
    const res = handleThemesRequest(new Request(url), url)
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as { themes: Record<string, WebThemePalette> }
    expect(Object.keys(json.themes)).toContain("claude")
  })

  it("405s a non-GET method", () => {
    const url = new URL("http://localhost/api/themes")
    const res = handleThemesRequest(new Request(url, { method: "POST" }), url)
    expect(res?.status).toBe(405)
  })
})
