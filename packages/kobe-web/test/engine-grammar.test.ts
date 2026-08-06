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

  test("a numbered › selection cursor is NOT the composer", () => {
    expect(codexGrammar.findInputRegion(CODEX_UPDATE_PROMPT)).toBeNull()
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
