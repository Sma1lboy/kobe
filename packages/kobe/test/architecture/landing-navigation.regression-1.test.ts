import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

// Regression: ISSUE-002 — changelog navigation targeted missing landing anchors
// Found by /qa on 2026-08-15
// Report: .gstack/qa-reports/qa-report-rove-sma1lboy-me-2026-08-15.md
describe("landing site navigation", () => {
  test("changelog links only to current landing sections and companion pages", () => {
    const source = read("packages/kobe-landing/changelog.html")

    expect(source).toContain('href="/#workflow"')
    expect(source).toContain('href="/#install"')
    expect(source).toContain('href="/plugins"')
    expect(source).toContain('href="/themes"')
    expect(source).not.toMatch(/href="\/#(?:workspace|why|engines)"/)
    expect(source).toContain('aria-current="page"')
  })
})
