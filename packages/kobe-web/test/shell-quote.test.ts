import { shellQuote } from "@sma1lboy/kobe-daemon/daemon/web-session"
import { describe, expect, it } from "vitest"


describe("shellQuote", () => {
  it("passes safe tokens through bare", () => {
    expect(shellQuote(["claude", "--model", "sonnet"])).toBe("claude --model sonnet")
    expect(shellQuote(["/usr/bin/codex", "exec"])).toBe("/usr/bin/codex exec")
  })

  it("single-quotes anything with spaces or shell metacharacters", () => {
    expect(shellQuote(["a b"])).toBe("'a b'")
    expect(shellQuote(["x;y"])).toBe("'x;y'")
    expect(shellQuote(["$(whoami)"])).toBe("'$(whoami)'")
    expect(shellQuote(["a&&b"])).toBe("'a&&b'")
    expect(shellQuote(["a|b"])).toBe("'a|b'")
  })

  it("escapes embedded single quotes so they can't close the quote", () => {
    expect(shellQuote(["a'b"])).toBe("'a'\\''b'")
  })

  it("neutralizes an injection attempt via an embedded quote", () => {
    const out = shellQuote(["'; rm -rf / #"])
    expect(out).toBe("''\\''; rm -rf / #'")
    expect(out.startsWith("'")).toBe(true)
    expect(out.endsWith("'")).toBe(true)
  })

  it("joins multiple args with single spaces", () => {
    expect(shellQuote(["a", "b c", "d"])).toBe("a 'b c' d")
  })
})
