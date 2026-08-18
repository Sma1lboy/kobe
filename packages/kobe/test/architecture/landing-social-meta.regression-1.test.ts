import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

// Regression: ISSUE-003 — large-card metadata shipped without a share image
// Found by /qa on 2026-08-15
// Report: .gstack/qa-reports/qa-report-rove-sma1lboy-me-2026-08-15.md
describe("landing social metadata", () => {
  test.each(["index.html", "plugins.html", "themes.html", "changelog.html"])(
    "%s declares the shared Open Graph and Twitter image",
    (page) => {
      const source = read(`packages/kobe-landing/${page}`)

      expect(source).toContain('property="og:image" content="https://rove.sma1lboy.me/assets/hero-flow-v2.png"')
      expect(source).toContain('property="og:image:alt"')
      expect(source).toContain('name="twitter:image" content="https://rove.sma1lboy.me/assets/hero-flow-v2.png"')
      expect(source).toContain('name="twitter:image:alt"')
    },
  )
})
