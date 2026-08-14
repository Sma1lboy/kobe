/** Distribution contract for the canonical Rove npm package and Kobe alias. */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")
const json = <T>(path: string): T => JSON.parse(read(path)) as T

describe("Rove package distribution", () => {
  test("the workspace package is canonical Rove while both CLI names remain available", () => {
    const pkg = json<{ name: string; bin: Record<string, string> }>("packages/kobe/package.json")

    expect(pkg.name).toBe("@sma1lboy/rove")
    expect(pkg.bin).toEqual({ kobe: "dist/cli/kobe.js", rove: "dist/cli/rove.js" })
  })

  test("workspace commands address the canonical package name", () => {
    const root = json<{ scripts: Record<string, string> }>("package.json")
    const commands = Object.values(root.scripts)

    expect(commands.some((command) => command.includes("--filter @sma1lboy/rove"))).toBe(true)
    expect(commands.some((command) => /--filter @sma1lboy\/kobe(?:\s|$)/.test(command))).toBe(false)
  })

  test("daemon typechecking does not rely on the renamed package's hoisted dependencies", () => {
    const daemon = json<{ devDependencies: Record<string, string> }>("packages/kobe-daemon/package.json")

    expect(daemon.devDependencies["@types/node"]).toBe("25.6.2")
  })

  test("release publishes Rove first and rewrites only the compatibility alias", () => {
    const workflow = read(".github/workflows/release.yml")
    const canonicalStep = workflow.indexOf("Publish canonical @sma1lboy/rove package")
    const compatibilityStep = workflow.indexOf("Publish compatibility alias @sma1lboy/kobe")

    expect(canonicalStep).toBeGreaterThanOrEqual(0)
    expect(compatibilityStep).toBeGreaterThan(canonicalStep)
    expect(workflow).toContain("pkg.name = '@sma1lboy/kobe'")
    expect(workflow).not.toContain("pkg.name = '@sma1lboy/rove'")
  })

  test("pending changesets version the canonical package", () => {
    const files = readdirSync(join(ROOT, ".changeset")).filter((name) => name.endsWith(".md") && name !== "README.md")

    for (const file of files) {
      const source = read(join(".changeset", file))
      expect(source, `${file} still targets the compatibility package`).not.toMatch(/^"@sma1lboy\/kobe":/m)
    }
  })

  test("active install surfaces point new users at Rove", () => {
    const surfaces = [
      "README.md",
      "docs/CLI.md",
      "docs/QUICKSTART.md",
      "docs/RELEASING.md",
      "packages/kobe/README.md",
      "packages/kobe-landing/index.html",
      "packages/kobe-landing/changelog.html",
      "packages/kobe-landing/plugins.html",
      "packages/kobe-landing/themes.html",
    ]

    for (const path of surfaces) {
      const source = read(path)
      expect(source, `${path} still recommends installing Kobe`).not.toMatch(
        /(?:install|-g|bunx)\s+@sma1lboy\/kobe(?:@[^\s<`]+)?/,
      )
      expect(source, `${path} still links to the compatibility npm package`).not.toMatch(
        /www\.npmjs\.com\/package\/@sma1lboy\/kobe(?:[/?#"')]|$)/,
      )
    }
  })
})
