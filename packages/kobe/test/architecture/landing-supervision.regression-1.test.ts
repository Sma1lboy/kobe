import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

// Regression: ISSUE-001 — landing page documented removed report/await commands
// Found by /qa on 2026-08-15
// Report: .gstack/qa-reports/qa-report-rove-sma1lboy-me-2026-08-15.md
describe("landing supervision workflow", () => {
  test("documents dispatcher replies without removed completion commands", () => {
    const source = [
      read("packages/kobe-landing/index.html"),
      read("packages/kobe-landing/index.js"),
      read("packages/kobe-landing/README.md"),
    ].join("\n")

    expect(source).toContain("rove api add --prompt")
    expect(source).toContain("--command")
    expect(source).toContain("--count 3")
    expect(source).toContain("rove api send --prompt")
    expect(source).not.toContain("rove api fan-out")
    expect(source).not.toContain("--vendor")
    expect(source).not.toContain("rove api report")
    expect(source).not.toContain("rove api await")
    expect(source).not.toContain("explicit reports")
    expect(source).not.toContain("显式结果上报")
  })
})
