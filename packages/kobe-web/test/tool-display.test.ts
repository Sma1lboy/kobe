import { describe, expect, it } from "vitest"
import type { ContentBlock } from "../src/lib/history.ts"
import { outputText, toolInputSummary } from "../src/lib/tool-display.ts"

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

const call = (input: unknown): ToolCall =>
  ({ type: "tool_call", callId: "c1", name: "T", input }) as ToolCall

describe("toolInputSummary — field priority", () => {
  it("labels a Bash call by its command", () => {
    expect(toolInputSummary(call({ command: "ls -la" }))).toBe("ls -la")
  })

  it("labels a Read/Edit call by its file_path", () => {
    expect(toolInputSummary(call({ file_path: "/a/b.ts" }))).toBe("/a/b.ts")
  })

  it("prefers command over file_path when both are present", () => {
    expect(toolInputSummary(call({ command: "x", file_path: "/y" }))).toBe("x")
  })

  it("falls back through pattern → url → description → prompt → query", () => {
    expect(toolInputSummary(call({ pattern: "TODO" }))).toBe("TODO")
    expect(toolInputSummary(call({ url: "https://x" }))).toBe("https://x")
    expect(toolInputSummary(call({ description: "do it" }))).toBe("do it")
    expect(toolInputSummary(call({ prompt: "go" }))).toBe("go")
    expect(toolInputSummary(call({ query: "find" }))).toBe("find")
  })

  it("ignores a non-string field value and picks the next candidate", () => {
    // command is a number → skip it, fall to file_path.
    expect(toolInputSummary(call({ command: 123, file_path: "/p" }))).toBe("/p")
  })

  it("truncates a long candidate to 90 chars with an ellipsis", () => {
    const long = "a".repeat(200)
    const out = toolInputSummary(call({ command: long }))
    expect(out).toHaveLength(90)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("toolInputSummary — fallbacks", () => {
  it("returns '' for an empty-object input", () => {
    expect(toolInputSummary(call({}))).toBe("")
  })

  it("returns '' for a null input", () => {
    expect(toolInputSummary(call(null))).toBe("")
  })

  it("stringifies a primitive (non-object) input", () => {
    expect(toolInputSummary(call(42))).toBe("42")
  })

  it("stringifies an object that has no recognized string field", () => {
    expect(toolInputSummary(call({ foo: "bar" }))).toBe('{"foo":"bar"}')
  })
})

describe("outputText", () => {
  it("passes a string through unchanged", () => {
    expect(outputText("hello")).toBe("hello")
  })

  it("renders null/undefined as empty", () => {
    expect(outputText(null)).toBe("")
    expect(outputText(undefined)).toBe("")
  })

  it("pretty-prints a non-string object as JSON", () => {
    expect(outputText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it("renders a number as JSON text", () => {
    expect(outputText(5)).toBe("5")
  })

  it("falls back to String() for an unserializable value (no throw)", () => {
    // JSON.stringify throws on a BigInt; outputText must not crash the
    // transcript render — it falls back to String().
    expect(outputText(BigInt(7))).toBe("7")
  })
})

describe("toolInputSummary — resilience", () => {
  it("returns '' for an unserializable input instead of throwing", () => {
    // A BigInt input is not an object (no field pick) and JSON.stringify throws
    // on it; the catch must yield '' so a pathological tool call can't crash
    // the transcript.
    expect(toolInputSummary(call(BigInt(7)))).toBe("")
  })

  it("returns '' for a circular-reference input", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    // No recognized string field → JSON.stringify throws on the cycle → ''.
    expect(toolInputSummary(call(circular))).toBe("")
  })
})
