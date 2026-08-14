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
    expect(root.scripts.postinstall).toBe("bun --filter @sma1lboy/rove-plugin-sdk build")
    expect(root.scripts.build).toMatch(/^bun --filter @sma1lboy\/rove-plugin-sdk build && /)
    expect(commands.some((command) => /--filter @sma1lboy\/kobe(?:\s|$)/.test(command))).toBe(false)
  })

  test("daemon typechecking does not rely on the renamed package's hoisted dependencies", () => {
    const daemon = json<{ devDependencies: Record<string, string> }>("packages/kobe-daemon/package.json")

    expect(daemon.devDependencies["@types/node"]).toBe("25.6.2")
  })

  test("the plugin SDK workspace and daemon dependency use the canonical Rove package", () => {
    const sdk = json<{
      name: string
      exports: Record<string, { types: string; default: string }>
      repository: { url: string }
      homepage: string
    }>("packages/kobe-plugin-sdk/package.json")
    const daemon = json<{ dependencies: Record<string, string> }>("packages/kobe-daemon/package.json")

    expect(sdk.name).toBe("@sma1lboy/rove-plugin-sdk")
    expect(sdk.exports["./contract"]).toEqual({
      types: "./dist/contract.d.ts",
      default: "./dist/contract.js",
    })
    expect(sdk.repository.url).toBe("git+https://github.com/Sma1lboy/rove.git")
    expect(sdk.homepage).toBe("https://github.com/Sma1lboy/rove/blob/main/docs/PLUGIN-AUTHORING.md")
    expect(daemon.dependencies["@sma1lboy/rove-plugin-sdk"]).toBe("workspace:*")
    expect(daemon.dependencies["@sma1lboy/kobe-plugin-sdk"]).toBeUndefined()
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

  test("release publishes the canonical plugin SDK before its identical compatibility alias", () => {
    const workflow = read(".github/workflows/release.yml")
    const canonicalStep = workflow.indexOf("Publish canonical plugin SDK")
    const compatibilityStep = workflow.indexOf("Publish plugin SDK compatibility alias")
    const releaseStep = workflow.indexOf("Create GitHub release")

    expect(canonicalStep).toBeGreaterThanOrEqual(0)
    expect(compatibilityStep).toBeGreaterThan(canonicalStep)
    expect(releaseStep).toBeGreaterThan(compatibilityStep)
    expect(workflow).toContain('npm view "@sma1lboy/rove-plugin-sdk@$V"')
    expect(workflow).toContain("pkg.name = '@sma1lboy/kobe-plugin-sdk'")
    const canonicalPublish = workflow.slice(canonicalStep, compatibilityStep)
    const compatibilityPublish = workflow.slice(compatibilityStep, releaseStep)
    expect(canonicalPublish).toContain("bun run build")
    expect(canonicalPublish).toContain(
      'npm publish --access public --provenance --tag "${{ steps.channel.outputs.dist_tag }}"',
    )
    expect(compatibilityPublish).toContain(
      'npm publish --access public --provenance --ignore-scripts --tag "${{ steps.channel.outputs.dist_tag }}"',
    )
  })

  test("pending changesets version the canonical package", () => {
    const files = readdirSync(join(ROOT, ".changeset")).filter((name) => name.endsWith(".md") && name !== "README.md")

    for (const file of files) {
      const source = read(join(".changeset", file))
      expect(source, `${file} still targets the compatibility package`).not.toMatch(/^"@sma1lboy\/kobe":/m)
      expect(source, `${file} still targets the compatibility SDK`).not.toMatch(/^"@sma1lboy\/kobe-plugin-sdk":/m)
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

  test("active repository links use the canonical Rove repository", () => {
    const surfaces = [
      ".claude/skills/changelog-generator/SKILL.md",
      ".claude/skills/recent-release/SKILL.md",
      "CONTRIBUTING.md",
      "README.md",
      "docs/themes.md",
      "packages/kobe-plugin-sdk/README.md",
      "packages/kobe-plugin-sdk/package.json",
      "packages/kobe-docs/lib/layout.shared.tsx",
      "packages/kobe-docs/scripts/sync-docs.mjs",
      "packages/kobe-landing/TODOS.md",
      "packages/kobe-landing/changelog.html",
      "packages/kobe-landing/index.html",
      "packages/kobe-landing/index.js",
      "packages/kobe-landing/plugins.html",
      "packages/kobe-landing/themes.html",
      "packages/kobe-landing/themes/catppuccin.json",
      "packages/kobe-landing/themes/everforest.json",
      "packages/kobe-landing/themes/gruvbox.json",
      "packages/kobe-landing/themes/kanagawa.json",
      "packages/kobe-landing/themes/rose-pine.json",
      "packages/kobe-landing/themes/solarized.json",
      "packages/kobe/scripts/build.ts",
      "packages/kobe/src/cli/theme.ts",
      "packages/kobe/src/lib/skill-install.ts",
      "packages/kobe/src/tui/context/theme/theme.schema.json",
      "scripts/release.sh",
    ]
    const legacyRepository =
      /(?:github\.com|raw\.githubusercontent\.com|api\.github\.com\/repos)\/sma1lboy\/kobe(?:\.git|[/?#"'`\s]|$)/i

    for (const path of surfaces) {
      const source = read(path)
      expect(source, `${path} does not point at the canonical repository`).toMatch(/sma1lboy\/rove/i)
      expect(source, `${path} still points at the redirected Kobe repository`).not.toMatch(legacyRepository)
    }

    expect(read("CONTRIBUTING.md")).toContain("git clone https://github.com/Sma1lboy/rove.git\ncd rove")
  })

  test("release-note skills target the canonical package and product", () => {
    const changelogSkill = read(".claude/skills/changelog-generator/SKILL.md")
    const recentReleaseSkill = read(".claude/skills/recent-release/SKILL.md")

    expect(changelogSkill).toContain('"@sma1lboy/rove": patch')
    expect(changelogSkill).not.toContain('"@sma1lboy/kobe":')
    expect(recentReleaseSkill).toContain("Recent Release Page (Rove)")
    expect(recentReleaseSkill).toContain("rove-release-notes-zh.html")
  })

  test("landing pages load their extracted static assets", () => {
    const home = read("packages/kobe-landing/index.html")
    const homeScript = read("packages/kobe-landing/index.js")
    const themes = read("packages/kobe-landing/themes.html")
    const themesScript = read("packages/kobe-landing/themes.js")
    const themesStyles = read("packages/kobe-landing/themes.css")

    expect(home).toContain('<script src="/index.js"></script>')
    expect(homeScript).toContain("https://api.github.com/repos/Sma1lboy/rove")
    expect(themes).toContain('<link rel="stylesheet" href="/themes.css">')
    expect(themes).toContain('<script src="/themes.js"></script>')
    expect(themesScript).toContain("var KOBE_I18N")
    expect(themesStyles).toContain(".tcard")
  })
})
