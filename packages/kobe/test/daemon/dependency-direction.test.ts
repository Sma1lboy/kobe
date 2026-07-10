/** Pins the daemon package as a consumer-owned seam, never a kobe source alias client. */

import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "vitest"

const daemonRoot = join(import.meta.dirname, "../../../kobe-daemon")
const sourceRoot = join(daemonRoot, "src")
const forbidden = /^(?:@\/|@tui\/|@engine\/|@orchestrator\/|@types\/)|(?:^|\/)\.\.\/kobe(?:\/|$)/
const specifier = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  })
}

describe("kobe-daemon dependency direction", () => {
  test("source imports never reach through kobe aliases or sibling paths", () => {
    const violations: string[] = []
    for (const file of sourceFiles(sourceRoot)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(specifier)) {
        const value = match[1] ?? match[2] ?? ""
        if (forbidden.test(value)) violations.push(`${relative(daemonRoot, file)} -> ${value}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("daemon tsconfig has no sibling-source path aliases", () => {
    const config = readFileSync(join(daemonRoot, "tsconfig.json"), "utf8")
    expect(config).not.toContain("../kobe/src")
    expect(JSON.parse(config).compilerOptions.paths).toBeUndefined()
  })
})
