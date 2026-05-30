import { describe, expect, it } from "vitest"
import { stripAnsi } from "../../src/monitor/capture-pane.ts"

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })

  it("removes cursor / erase CSI sequences", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Ghello")).toBe("hello")
  })

  it("removes OSC sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi("\x1b]0;window title\x07text")).toBe("text")
    expect(stripAnsi("\x1b]8;;http://example.com\x1b\\link")).toBe("link")
  })

  it("removes charset designators", () => {
    expect(stripAnsi("\x1b(Bplain")).toBe("plain")
  })

  it("keeps newlines and ordinary text", () => {
    expect(stripAnsi("line1\nline2")).toBe("line1\nline2")
    expect(stripAnsi("no escapes here")).toBe("no escapes here")
  })
})
