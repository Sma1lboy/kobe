import { describe, expect, test } from "vitest"
import {
  codexGrammar,
  grammarFor,
  rawGrammar,
} from "../src/lib/engine-grammar.ts"

// Fixture: Codex CLI v0.146 screens sampled from a live PTY (pyte-rendered).
const CODEX_MAIN = [
  "╭─────────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.146.0)                      │",
  "│                                                 │",
  "│ model:     gpt-5.6-sol xhigh   /model to change │",
  "│ directory: ~/i/kobe                             │",
  "╰─────────────────────────────────────────────────╯",
  "",
  "• You have 1 usage limit reset available.",
  "",
  "",
  "› Summarize recent commits",
  "",
  "  gpt-5.6-sol xhigh · ~/i/kobe",
]

const CODEX_UPDATE_PROMPT = [
  "See full release notes:",
  "",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
]

describe("codex grammar", () => {
  test("finds the › composer with its status tail", () => {
    const region = codexGrammar.findInputRegion(CODEX_MAIN)
    expect(region).not.toBeNull()
    expect(region?.promptRow).toBe(10)
    expect(region?.promptText).toBe("Summarize recent commits")
    expect(region?.statusLines).toEqual(["  gpt-5.6-sol xhigh · ~/i/kobe"])
  })

  test("a numbered › selection cursor anchors a pseudo-region (dialog stays translated)", () => {
    const region = codexGrammar.findInputRegion(CODEX_UPDATE_PROMPT)
    expect(region?.promptText).toBe("")
    expect(region?.statusLines).toEqual([])
    // Anchored at the bottom row: every dialog row above stays in the body.
    expect(region?.promptRow).toBe(4)
  })

  test("slash menu parses into a menu block", () => {
    const line = (text: string) => ({ text, segs: [] })
    const blocks = codexGrammar.parseBlocks([
      line("  /model         choose what model and reasoning effort to use"),
      line("  /fast          1.5x speed, increased usage"),
      line("  /permissions   choose what Codex is allowed to do"),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("menu")
  })
})

describe("grammarFor", () => {
  test("unknown vendors fall back to the raw grammar", () => {
    expect(grammarFor("aider")).toBe(rawGrammar)
    expect(rawGrammar.findInputRegion(CODEX_MAIN)).toBeNull()
  })
})

describe("codex welcome + open menu", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("boxed welcome banner folds into a welcome card", () => {
    const blocks = codexGrammar.parseBlocks([
      line("╭───────────────────────────────╮"),
      line("│ >_ OpenAI Codex (v0.146.0)    │"),
      line("│                               │"),
      line("│ model:     gpt-5.6-sol xhigh  │"),
      line("│ directory: ~/i/kobe           │"),
      line("╰───────────────────────────────╯"),
      line(""),
      line("• You have 1 usage limit reset available."),
    ])
    const welcome = blocks.find((b) => b.kind === "welcome")
    expect(welcome).toMatchObject({
      welcome: {
        product: "OpenAI Codex",
        version: "0.146.0",
        vendor: "codex",
        info: ["model:  gpt-5.6-sol xhigh", "directory: ~/i/kobe"],
      },
    })
  })

  test("update box folds into the welcome card as a notice", () => {
    const blocks = codexGrammar.parseBlocks([
      line("╭──────────────────────────────────────╮"),
      line("│ ✨ Update available! 0.146.0 → 0.146.1 │"),
      line("│ Run bun install -g @openai/codex      │"),
      line("╰──────────────────────────────────────╯"),
      line(""),
      line("╭───────────────────────────────╮"),
      line("│ >_ OpenAI Codex (v0.146.0)    │"),
      line("│ directory: ~/i/kobe           │"),
      line("╰───────────────────────────────╯"),
    ])
    const welcomes = blocks.filter((b) => b.kind === "welcome")
    expect(welcomes).toHaveLength(1)
    expect(welcomes[0]).toMatchObject({
      welcome: {
        product: "OpenAI Codex",
        notice: [
          "✨ Update available! 0.146.0 → 0.146.1",
          "Run bun install -g @openai/codex",
        ],
      },
    })
    // No raw box lines survive.
    expect(blocks.some((b) => b.kind === "line" && b.line.text.includes("╭"))).toBe(false)
  })

  test("composer still found with the below-composer menu open", () => {
    const region = codexGrammar.findInputRegion([
      "• You have 1 usage limit reset available.",
      "",
      "› /",
      "",
      "  /model         choose what model and reasoning effort to use",
      "  /fast          1.5x speed, increased usage",
      "  /ide           include current selection",
      "  /permissions   choose what Codex is allowed to do",
      "  /keymap        remap TUI shortcuts",
      "  /vim           toggle Vim mode for the composer",
      "  /experimental  toggle experimental features",
      "  /approve       approve one retry of a recent auto-review denial",
    ])
    expect(region?.promptText).toBe("/")
    expect(region?.promptRow).toBe(2)
  })
})

describe("claude composer mode label", () => {
  test("the labeled top rule absorbs into the region with modeLabel", () => {
    const { claudeGrammar } = require("../src/lib/engine-grammar.ts")
    const region = claudeGrammar.findInputRegion([
      "● some reply",
      "",
      "──────────────────────────── ultracode ─",
      "❯ ",
      "────────────────────────────",
      "  Ctx: 0 | Out: —",
    ])
    expect(region?.modeLabel).toBe("ultracode")
    expect(region?.topRow).toBe(2)
  })

  test("bare label row under its rule absorbs too", () => {
    const { claudeGrammar } = require("../src/lib/engine-grammar.ts")
    const region = claudeGrammar.findInputRegion([
      "● some reply",
      "",
      "────────────────────────────",
      "                   ultracode ─",
      "❯ ",
      "────────────────────────────",
      "  Ctx: 0 | Out: —",
    ])
    expect(region?.modeLabel).toBe("ultracode")
    expect(region?.topRow).toBe(2)
  })
})

describe("codex relaunch banners", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("the LAST welcome box becomes the card; earlier ones stay history", () => {
    const boxed = (rows: string[]) => [
      line("╭──────────────────────────────╮"),
      ...rows.map((r) => line(`│ ${r.padEnd(28, " ")} │`)),
      line("╰──────────────────────────────╯"),
    ]
    const blocks = codexGrammar.parseBlocks([
      ...boxed([">_ OpenAI Codex (v0.146.0)", "directory: ~/one"]),
      line(""),
      line("bytedance@host dir % codex"),
      ...boxed([">_ OpenAI Codex (v0.146.0)", "directory: ~/two"]),
    ])
    const welcomes = blocks.filter((b) => b.kind === "welcome")
    expect(welcomes).toHaveLength(1)
    const w = welcomes[0]
    if (w.kind !== "welcome") throw new Error("unreachable")
    expect(w.welcome.info).toContain("directory: ~/two")
    // The earlier banner stays as verbatim history rows.
    expect(
      blocks.some((b) => b.kind === "line" && b.line.text.includes("~/one")),
    ).toBe(true)
  })
})
