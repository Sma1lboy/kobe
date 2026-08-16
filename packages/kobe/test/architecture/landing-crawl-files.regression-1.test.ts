import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

// Regression: ISSUE-005 — the public site returned 404 for robots.txt and sitemap.xml
// Found by /qa on 2026-08-15
// Report: .gstack/qa-reports/qa-report-rove-sma1lboy-me-2026-08-15.md
describe("landing crawl metadata", () => {
  test("robots.txt allows crawling and advertises the sitemap", () => {
    const robots = read("packages/kobe-landing/robots.txt")

    expect(robots).toContain("User-agent: *")
    expect(robots).toContain("Allow: /")
    expect(robots).toContain("Sitemap: https://rove.sma1lboy.me/sitemap.xml")
  })

  test("sitemap lists every canonical public landing page", () => {
    const sitemap = read("packages/kobe-landing/sitemap.xml")

    for (const path of ["/", "/plugins", "/themes", "/changelog"]) {
      expect(sitemap).toContain(`<loc>https://rove.sma1lboy.me${path}</loc>`)
    }
  })
})
