import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

// Regression: ISSUE-004 — engine selector exposed its state only through color
// Found by /qa on 2026-08-15
// Report: .gstack/qa-reports/qa-report-rove-sma1lboy-me-2026-08-15.md
describe("landing engine selector accessibility", () => {
  test("declares and updates a programmatic pressed state", () => {
    const markup = read("packages/kobe-landing/index.html")
    const behavior = read("packages/kobe-landing/index.js")

    expect(markup).toContain('id="enginePills" role="group"')
    expect(markup.match(/class="engine-pill"/g)).toHaveLength(5)
    expect(markup.match(/aria-pressed="(?:true|false)"/g)).toHaveLength(5)
    expect(behavior).toContain("p.setAttribute('aria-pressed', 'false')")
    expect(behavior).toContain("pill.setAttribute('aria-pressed', 'true')")
  })
})
