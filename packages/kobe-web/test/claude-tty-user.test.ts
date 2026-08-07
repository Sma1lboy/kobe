import { describe, expect, test } from "vitest"
import { parseTtyBlocks } from "../src/lib/claude-tty.ts"

const line = (text: string) => ({ text, segs: [{ text, color: null }] })

describe("parseTtyBlocks user echo", () => {
  test("multi-line message folds into one user bubble", () => {
    const blocks = parseTtyBlocks([
      line("> Work on user story #2: wadaw"),
      line("  dwaawdawdawd"),
      line(""),
      line("  You are working directly in the project checkout."),
      line(""),
      line("● 收到,先看一下 issue #2。"),
    ])
    const users = blocks.filter((b) => b.kind === "user")
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      text: "Work on user story #2: wadaw\ndwaawdawdawd\n\nYou are working directly in the project checkout.",
    })
    // The assistant bullet stays outside the bubble.
    expect(blocks.some((b) => b.kind === "activity" || b.kind === "line")).toBe(
      true,
    )
  })

  test("single-line message unchanged", () => {
    const blocks = parseTtyBlocks([line("> hello"), line("● hi")])
    expect(blocks.filter((b) => b.kind === "user")).toEqual([
      { kind: "user", text: "hello" },
    ])
  })
})

describe("groupCopyRuns copy text", () => {
  test("strips the bullet and its 2-space continuation indent", async () => {
    const { groupCopyRuns } = await import("../src/components/TtyBlocksView.tsx")
    const runs = groupCopyRuns([
      { kind: "line", line: { text: "● 这串数字看起来像误输入了。", segs: [] } },
      { kind: "line", line: { text: "  有什么需要我做的吗?", segs: [] } },
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: "run",
      text: "这串数字看起来像误输入了。\n有什么需要我做的吗?",
    })
  })
})

describe("recap block", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("absorbs continuations and strips the config hint", () => {
    const blocks = parseTtyBlocks([
      line("※ recap: 你刚才只是让我随便调几个工具试试,我跑了 git log"),
      line("  和目录列表,一切正常。 (disable recaps in /config)"),
      line(""),
    ])
    expect(blocks).toEqual([
      {
        kind: "recap",
        text: "你刚才只是让我随便调几个工具试试,我跑了 git log 和目录列表,一切正常。",
      },
    ])
  })
})

describe("boxed narrow-width welcome banner", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("folds into the welcome card, dropping the inner tips column", () => {
    const blocks = parseTtyBlocks([
      line("╭─── Claude Code v2.1.223 ──────────────────────╮"),
      line("│                                │ Tips for      │"),
      line("│      Welcome back codefox!     │ getting       │"),
      line("│         ▐▛███▜▌               │ What's new    │"),
      line("│        ▝▜█████▛▘              │ Added owner … │"),
      line("│  Fable 5 with high effort ·    │ Added a warn… │"),
      line("│     /…/scratchpad/probe        │ /release-not… │"),
      line("╰────────────────────────────────────────────────╯"),
    ])
    expect(blocks).toHaveLength(1)
    const b = blocks[0]
    if (b.kind !== "welcome") throw new Error("expected welcome block")
    expect(b.welcome.product).toBe("Claude Code")
    expect(b.welcome.version).toBe("2.1.223")
    expect(b.welcome.logo.length).toBe(2)
    expect(b.welcome.info).toEqual([
      "Welcome back codefox!",
      "Fable 5 with high effort ·",
      "/…/scratchpad/probe",
    ])
  })
})

describe("reflowed side-by-side welcome banner", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("text-only rows inside the block still fold into the card", () => {
    const blocks = parseTtyBlocks([
      line(" ▐▛███▜▌   Claude Code v2.1.223"),
      line("▝▜█████▛▘  Fable 5 with high effort"),
      line("  ▘▘ ▝▝    Claude Max"),
      line("           ~/i/MAG"),
      line(""),
      line("● hey"),
    ])
    const welcome = blocks.find((b) => b.kind === "welcome")
    if (!welcome || welcome.kind !== "welcome") throw new Error("no welcome")
    expect(welcome.welcome.product).toBe("Claude Code")
    expect(welcome.welcome.version).toBe("2.1.223")
    expect(welcome.welcome.logo).toHaveLength(3)
    expect(welcome.welcome.info).toEqual([
      "Fable 5 with high effort",
      "Claude Max",
      "~/i/MAG",
    ])
  })
})

describe("version line floated above the art", () => {
  const line = (text: string) => ({ text, segs: [] })

  test("the block still folds into the card", () => {
    const blocks = parseTtyBlocks([
      line("           Claude Code v2.1.223"),
      line(" ▐▛███▜▌   Fable 5 with high e…"),
      line("▝▜█████▛▘  Claude Max"),
      line("  ▘▘ ▝▝    ~/i/auto-director"),
      line(""),
    ])
    const welcome = blocks.find((b) => b.kind === "welcome")
    if (!welcome || welcome.kind !== "welcome") throw new Error("no welcome")
    expect(welcome.welcome.version).toBe("2.1.223")
    expect(welcome.welcome.info).toContain("~/i/auto-director")
    expect(blocks.filter((b) => b.kind === "line")).toHaveLength(0)
  })
})

describe("reflowed user-echo continuation", () => {
  test("a flush-left soft-wrap tail after a full-width row stays in the bubble", () => {
    const W = 44
    const pad = (t: string) => ({ text: t.padEnd(W, " "), segs: [] })
    const full = (t: string) => ({ text: t.padEnd(W, "x").slice(0, W), segs: [] })
    const blocks = parseTtyBlocks([
      pad("> /effort high"),
      full("  ⎿ Set effort level to high (saved): Comp"),
      pad("rehensive implementation with tests"),
      pad(""),
      pad("● next reply"),
    ])
    const user = blocks.find((b) => b.kind === "user")
    if (!user || user.kind !== "user") throw new Error("no user block")
    expect(user.text).toContain("rehensive implementation with tests")
    expect(
      blocks.some(
        (b) => b.kind === "line" && b.line.text.includes("rehensive"),
      ),
    ).toBe(false)
  })
})
