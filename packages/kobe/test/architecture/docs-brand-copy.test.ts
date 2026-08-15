/**
 * Rename guard for CURRENT documentation, landing copy, active agent skills,
 * and the generated docs illustrations.
 *
 * `package-distribution.test.ts` pins the npm/repository contract and
 * `active-product-copy.test.ts` pins retired-architecture claims. Neither sees
 * the third failure mode of the Kobe -> Rove rename: a page that still tells a
 * user to run `kobe …`, or prints a state path / branch prefix Rove no longer
 * writes. Those are silent because they are only wrong for NEW users.
 *
 * NEGATIVE assertions only, same rule as `active-product-copy.test.ts`: assert
 * the absence of the stale spelling, never the presence of an exact sentence.
 *
 * Deliberately NOT covered here, because they are preserved compatibility:
 * the `kobe` executable and `@sma1lboy/kobe` package, `KOBE_*` env aliases,
 * `packages/kobe*` workspace names, `~/.kobe` runtime + plugin paths, legacy
 * `.kobe/worktrees` discovery, the `kobe-plugin` topic, `kobe.sma1lboy.me`,
 * the installed `.agents/skills/kobe/SKILL.md` path,
 * the persisted `kobe hook` invocation, and `[KOBE PEER]`/`[KOBE FIELD NOTE]`.
 * Historical records (`docs/adr/`, `docs/superpowers/`, CHANGELOG, and the
 * superseded design notes) keep their original wording on purpose.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

/** Design notes that document CURRENT behavior, so their commands must run. */
const CURRENT_DESIGN_DOCS = [
  "docs/design/automations.md",
  "docs/design/dispatcher.md",
  "docs/design/engine-internals.md",
  "docs/design/herdr-gap-analysis.md",
  "docs/design/keybinding-decisions.md",
  "docs/design/plugins.md",
  "docs/design/remote-projects.md",
  "docs/design/remote-topology-status.md",
  "docs/design/tasks.md",
  "docs/design/terminal-graphics.md",
  "docs/design/web-dashboard.md",
  "docs/design/work-items.md",
]

/**
 * A `kobe <verb>` the reader is expected to TYPE. `kobe hook` is excluded: it
 * is persisted into engine config files by `kobeHookInvocation()` and must
 * keep the guaranteed legacy name.
 */
const TYPED_KOBE_COMMAND =
  /\bkobe (?!hook\b)(api|daemon|doctor|reset|update|plugin|theme|repo|config|web|add|remove|export|completions|pty-host)\b/

/**
 * The product called by its retired name. Compatibility spellings survive the
 * lookahead: `packages/kobe-docs`, `kobe-plugin`, `.agents/skills/kobe/`,
 * `packages/kobe/src/…`, and `kobe.sma1lboy.me` all continue with `-`, `/`,
 * or `.`, so only a bare "kobe"/"Kobe"/"kobe's" — the product itself — trips.
 */
const PRODUCT_NAME_KOBE = /\bkobe(?:['’]s)?\b(?![-/.])/i

/** Product-data paths that moved to the Rove layout. */
const MOVED_STATE_PATHS = ["~/.kobe/tasks.json", "~/.kobe/settings/", "~/.kobe/themes/", "~/.config/kobe/state.json"]

describe("current docs and landing copy speak Rove", () => {
  test.each(CURRENT_DESIGN_DOCS)("%s tells the reader to run rove", (path) => {
    const match = TYPED_KOBE_COMMAND.exec(read(path))
    expect(match?.[0], `${path} still documents "${match?.[0]}"`).toBeUndefined()
  })

  test.each(["CONTEXT.md", "docs/CLI.md", "docs/CONFIGURATION.md", "docs/KEYBINDINGS.md", "docs/themes.md"])(
    "%s prints canonical Rove state paths",
    (path) => {
      const source = read(path)
      for (const stale of MOVED_STATE_PATHS) {
        expect(source, `${path} still points at ${stale}`).not.toContain(stale)
      }
    },
  )

  test("the CLI environment table leads with the canonical names", () => {
    const source = read("docs/CLI.md")
    const table = source.slice(source.indexOf("## Environment variables"))
    // A `| \`KOBE_…\` |` first cell means the alias is being taught as the
    // primary spelling; prose mentions of the aliases stay welcome.
    expect(table, "docs/CLI.md documents a KOBE_* alias as the primary name").not.toMatch(/^\|\s*`KOBE_/m)
  })

  test("docs and issue templates use the canonical repository and CLI", () => {
    expect(read("docs/TUI.md"), "docs/TUI.md links the redirected repository").not.toMatch(
      /github\.com\/Sma1lboy\/kobe\//i,
    )

    const bugReport = read(".github/ISSUE_TEMPLATE/bug_report.md")
    expect(bugReport, "the bug template still asks for `kobe` diagnostics").not.toMatch(TYPED_KOBE_COMMAND)
    expect(bugReport, "the bug template still asks for `kobe --version`").not.toContain("kobe --version")

    const engineRequest = read(".github/ISSUE_TEMPLATE/engine-support-request.md")
    expect(engineRequest, "the engine template still calls the product Kobe").not.toContain("Kobe")
  })

  test.each(["docs/design/herdr-gap-analysis.md", ".claude/skills/file-issue/SKILL.md"])(
    "%s calls the product Rove",
    (path) => {
      const match = PRODUCT_NAME_KOBE.exec(read(path))
      expect(match?.[0], `${path} still calls the product "${match?.[0]}"`).toBeUndefined()
    },
  )

  test("the active file-issue skill teaches rove commands", () => {
    const source = read(".claude/skills/file-issue/SKILL.md")
    const match = TYPED_KOBE_COMMAND.exec(source)
    expect(match?.[0], `the file-issue skill still teaches "${match?.[0]}"`).toBeUndefined()
  })

  test("the landing page prints Rove state paths and branch names", () => {
    for (const path of ["packages/kobe-landing/themes.html", "packages/kobe-landing/themes.js"]) {
      expect(read(path), `${path} still writes themes to the legacy state dir`).not.toContain("~/.kobe/themes/")
    }
    // The fan-out demo renders the branch Rove actually creates (`rove/<slug>`),
    // both in the animated JS and in the static markup the animation replaces.
    expect(read("packages/kobe-landing/index.js"), "the fan-out demo still prints kobe/ branches").not.toContain(
      "'kobe/'",
    )
    // `kobe.sma1lboy.me` stays (canonical domain); only a `kobe/<branch>` slug is stale.
    expect(
      read("packages/kobe-landing/index.html"),
      "the static fan-in fallback still prints a kobe/ branch",
    ).not.toMatch(/\bkobe\/[a-z0-9]/i)
  })

  test("generated docs illustrations render the Rove worktree root and branch prefix", () => {
    for (const path of ["packages/branding/src/docs/DocsFanOut.tsx", "packages/branding/src/docs/DocsTaskModel.tsx"]) {
      const source = read(path)
      expect(source, `${path} draws the legacy worktree root`).not.toContain("~/.kobe/")
      expect(source, `${path} draws a legacy branch prefix`).not.toContain("kobe/")
    }
  })

  test("brand metadata carries the canonical display name", () => {
    const meta = read("marketing/brand.meta.yaml")
    // `id:` stays "kobe" — it keys marketing.studio.yaml and the accepted-asset
    // ledger. Only the display names are the product's public name.
    expect(meta, "brand.meta.yaml still names the product kobe").not.toMatch(/^\s*name:\s*"kobe"\s*$/m)
  })
})
