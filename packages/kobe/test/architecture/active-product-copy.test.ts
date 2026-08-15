/**
 * Staleness guard for product copy that lives OUTSIDE `packages/kobe/src`.
 *
 * `no-tmux-runtime.test.ts` scans the shipped source for references to the
 * retired tmux runtime, but it cannot see the landing page, the marketing
 * metadata, the web dashboard, or the design docs — and those are exactly
 * where a retired-architecture claim survives longest, because nobody
 * re-reads them.
 *
 * NEGATIVE assertions only, deliberately. A `toContain("<exact sentence>")`
 * pin does not guard an invariant; it freezes copy, so every rewording fails
 * a test that caught no regression. If you want to require that a surface
 * SAYS something, assert the absence of the thing it must not say instead —
 * that survives translation, rewording, and layout changes. Do not re-add
 * positive copy pins here.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

/** Every surface outside `packages/kobe/src`, with the claims it must not make. */
const STALE_CLAIMS: Array<[path: string, phrases: string[]]> = [
  [
    "packages/kobe-landing/index.html",
    [
      "persistent tmux sessions",
      "tmux session",
      "Close your laptop",
      "close the laptop",
      "合上笔记本",
      "需要 Bun ≥ 1.3.11、tmux",
    ],
  ],
  ["packages/kobe-web/src/components/ToolsPanel.tsx", ["tmux session and engine"]],
  ["packages/kobe-web/README.md", ["kobe-sandbox tmux socket"]],
  [".claude/skills/release/SKILL.md", ["needs tmux", "apt-installed tmux"]],
  ["marketing/brand.meta.yaml", ["git worktrees, tmux sessions", "persistent tmux sessions"]],
  ["docs/design/tasks.md", ["inside a tmux pane/embedded terminal"]],
  ["docs/design/web-dashboard.md", ["Ensure a task's tmux session", "killing the task's tmux session"]],
  ["docs/design/dispatcher.md", ["send` pastes via tmux"]],
  ["docs/design/daemon.md", ["never tears down tmux sessions"]],
  // Not tmux, but the same failure mode: a status line that outlived its truth.
  ["docs/design/remote-projects.md", ["phases 1–6 done"]],
]

/** Rename leaks on active harness/web/CI surfaces, scoped to definite stale copy. */
const STALE_RENAME_COPY: Array<[path: string, phrases: string[]]> = [
  ["packages/kobe-web/index.html", ["<title>kobe-web</title>"]],
  ["packages/kobe-web/pty-server.mjs", ["kobe pty-server listening"]],
  ["packages/kobe/scripts/check-preview-deps.ts", ["kobe — preview-pane system dependencies"]],
  [".github/workflows/claude-code-review.yml", ["`CLAUDE.md` and `packages/kobe/CLAUDE.md`", "kobe's house rules"]],
  [
    "packages/kobe-web/e2e/visual-fixture.ts",
    ["./src/cli/kobe.ts", 'join(XDG_CONFIG_HOME, "kobe")', '"skills", "kobe", "SKILL.md"', "/kobe-skill-version:"],
  ],
  ["packages/kobe-web/e2e/hero-fixture.ts", ['join(HERO_CONFIG, "kobe")']],
]

describe("active product copy", () => {
  test.each(STALE_CLAIMS)("%s makes no retired claim", (path, phrases) => {
    const source = read(path)
    for (const stale of phrases) expect(source, `${path} still claims "${stale}"`).not.toContain(stale)
  })

  test.each(STALE_RENAME_COPY)("%s makes no active Kobe-first claim", (path, phrases) => {
    const source = read(path)
    for (const stale of phrases) expect(source, `${path} still contains ${stale}`).not.toContain(stale)
  })

  test("current product pages do not publish pre-Rove terminal recordings", () => {
    // Captures re-shot as Rove through the browser `/harness` path
    // (`packages/kobe-web/e2e/hero-*.ts`, docs/HARNESS.md) are current product
    // renderings and may be published: `demo.*`, `workspace.png`,
    // `diff-review.png`, `narrow-sidebar.png`, `routines.png`, and the kanban
    // set (`kanban.png`, `kanban-story.png`, `kanban.gif`/`.mp4`, shot by
    // `hero-issues.ts` + `hero-kanban.ts`). What stays barred is every still
    // nobody has re-shot: those still photograph the kobe-era TUI, wordmark
    // and all.
    const stale = ["inbox.png", "new-session-dialog.png"]
    for (const page of ["README.md", "docs/TUI.md"]) {
      const source = read(page)
      for (const asset of stale) {
        expect(source, `${page} still publishes historical ${asset}`).not.toContain(`assets/${asset}`)
      }
    }

    const landing = read("packages/kobe-landing/index.html")
    expect(landing).not.toContain("assets/quicklook.mp4")
    expect(landing).not.toContain("assets/quicklook-poster.jpg")
  })
})
