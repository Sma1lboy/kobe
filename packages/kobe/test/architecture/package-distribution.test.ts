/** Distribution contract for the canonical Rove npm package and Kobe alias. */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")
const json = <T>(path: string): T => JSON.parse(read(path)) as T

describe("Rove package distribution", () => {
  test("the docs build embeds demo videos from its own static asset tree", () => {
    execFileSync("bun", ["packages/kobe-docs/scripts/sync-docs.mjs"], {
      cwd: ROOT,
      stdio: "pipe",
    })

    for (const [page, video] of [
      ["tui", "kanban"],
      ["routines", "routines"],
    ] as const) {
      const generated = read(`packages/kobe-docs/content/docs/${page}.mdx`)
      expect(generated).toContain("<video controls playsInline")
      expect(generated).toContain(`poster="/docs-assets/${video}.png"`)
      expect(generated).toContain(`src="/docs-assets/${video}.mp4"`)
      expect(generated).toContain(`](/docs-assets/${video}.mp4)`)
      expect(existsSync(join(ROOT, `packages/kobe-docs/public/docs-assets/${video}.mp4`))).toBe(true)
    }
  })

  test("the workspace package is canonical Rove while both CLI names remain available", () => {
    const pkg = json<{ name: string; bin: Record<string, string> }>("packages/kobe/package.json")

    expect(pkg.name).toBe("@sma1lboy/rove")
    expect(pkg.bin).toEqual({ kobe: "dist/cli/kobe.js", rove: "dist/cli/rove.js" })
  })

  test("the bins are node launchers fronting the Bun bundles, so npm/npx installs run", () => {
    const build = read("packages/kobe/scripts/build.ts")
    const launcher = read("packages/kobe/src/cli/launcher.ts")

    // `npm install -g` and `npx` start a bin with node, `bun install -g`
    // symlinks it and starts it with Bun. The bin file has one shebang, so
    // it is the node launcher, and the Bun bundle moves to `<name>-run.js`.
    expect(launcher.startsWith("#!/usr/bin/env node")).toBe(true)
    expect(build).toContain('const CLI_NAMES = ["kobe", "rove"] as const')
    expect(build).toContain('writeExecutable(`./dist/cli/${name}-run.js`, "#!/usr/bin/env bun", bundle)')
    expect(build).toContain('writeExecutable(`./dist/cli/${name}.js`, "#!/usr/bin/env node", launcherCode)')
    expect(build).toContain('entrypoints: ["./src/cli/launcher.ts"]')
    // The launcher runs before any Bun exists: no Bun-only import may reach it.
    expect(launcher).not.toMatch(/from "\.\/(?!bun-runtime)/)
  })

  test("acceptance tooling defaults to the built Rove artifacts while retaining explicit alias coverage", () => {
    const harness = read("packages/kobe/test/behavior/harness.ts")
    const visualFixture = read("packages/kobe-web/e2e/visual-fixture.ts")
    const heroFixture = read("packages/kobe-web/e2e/hero-fixture.ts")
    const build = read("packages/kobe/scripts/build.ts")

    expect(harness).toContain('DIST_ROVE_CLI = join(PKG_ROOT, "dist/cli/rove.js")')
    expect(harness).toContain('DIST_KOBE_CLI = join(PKG_ROOT, "dist/cli/kobe.js")')
    expect(harness).not.toContain('DIST_CLI = join(PKG_ROOT, "dist/cli/kobe.js")')
    expect(visualFixture).toContain('const ROVE_CLI = join(KOBE_DIR, "dist", "cli", "rove.js")')
    expect(visualFixture).toContain('const ROVE_SKILL = join(KOBE_DIR, "dist", "skills", "rove", "SKILL.md")')
    expect(visualFixture).toContain('join(XDG_CONFIG_HOME, "rove")')
    expect(heroFixture).toContain('join(HERO_CONFIG, "rove")')
    expect(build).toContain('const SKILL_OUT_DIR = "./dist/skills/rove"')
  })

  test.each([
    [".github/workflows/ci.yml", "\n  coverage-cap:"],
    [".github/workflows/release.yml", "\n  publish:"],
  ])("%s builds the Rove artifacts before the visual journey", (path, nextJob) => {
    const workflow = read(path)
    const start = workflow.indexOf("\n  visual-ground-truth:")
    const end = workflow.indexOf(nextJob, start)
    const job = workflow.slice(start, end)
    const build = job.indexOf("name: Build canonical Rove artifacts")
    const visual = job.indexOf("name: Visual journey (browser → PTY → real OpenTUI)")

    expect(start, `${path} has no visual-ground-truth job`).toBeGreaterThanOrEqual(0)
    expect(end, `${path} has no job after visual-ground-truth`).toBeGreaterThan(start)
    expect(build, `${path} does not build dist/ before visual tests`).toBeGreaterThanOrEqual(0)
    expect(visual, `${path} has no visual journey step`).toBeGreaterThan(build)
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
    const releasePageAssets = [
      ".claude/skills/recent-release/assets/template.html",
      ".claude/skills/recent-release/assets/example.html",
    ]

    expect(changelogSkill).toContain('"@sma1lboy/rove": patch')
    expect(changelogSkill).not.toContain('"@sma1lboy/kobe":')
    expect(recentReleaseSkill).toContain("Recent Release Page (Rove)")
    expect(recentReleaseSkill).toContain("rove-release-notes-zh.html")

    for (const path of releasePageAssets) {
      const source = read(path)
      expect(source, `${path} still brands generated pages as Kobe`).toContain("<title>Rove · 近期发版速览</title>")
      expect(source, `${path} still advertises the compatibility package`).toContain(
        '<span class="chip">包 <b>@sma1lboy/rove</b></span>',
      )
      expect(source, `${path} still prints the compatibility install command`).toContain(
        '<span class="prompt">npm i -g @sma1lboy/rove&nbsp;&nbsp;·&nbsp;&nbsp;rove</span>',
      )
    }
  })

  test("release guidance verifies the canonical package before compatibility aliases", () => {
    const releaseSkill = read(".claude/skills/release/SKILL.md")
    const releasingDocs = read("docs/RELEASING.md")

    expect(releaseSkill).toContain("# Release Rove")
    expect(releaseSkill).toContain('"@sma1lboy/rove": minor')
    expect(releaseSkill).not.toContain('"@sma1lboy/kobe": minor')
    expect(releaseSkill.indexOf("npm view @sma1lboy/rove@<new-version>")).toBeLessThan(
      releaseSkill.indexOf("npm view @sma1lboy/kobe@<new-version>"),
    )
    expect(releaseSkill).toContain("npm view @sma1lboy/rove-plugin-sdk@<sdk-version>")
    expect(releaseSkill).toContain("npm view @sma1lboy/kobe-plugin-sdk@<sdk-version>")
    expect(releaseSkill).toContain("Every Rove release checks the SDK's current version")
    expect(releaseSkill).not.toContain("If this release carried an SDK changeset")
    expect(releasingDocs).toContain("default to `patch` for every change")
    expect(releasingDocs).toContain("only when the maintainer explicitly requests that bump")
    expect(releasingDocs).not.toContain("`minor` for features")
  })

  test("contributor guidance uses Rove while naming retained compatibility paths explicitly", () => {
    const contributing = read("CONTRIBUTING.md")

    expect(contributing).toContain("# Contributing to Rove")
    expect(contributing).toContain("`~/.rove` (production)")
    expect(contributing).toContain("Won't touch your real `~/.rove` state")
    expect(contributing).toContain("The `.kobe` runtime path remains a compatibility contract")
    expect(contributing).toContain("Use `rove daemon restart`")
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
