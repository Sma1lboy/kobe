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
