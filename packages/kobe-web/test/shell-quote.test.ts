import { describe, expect, it } from "vitest"
import { shellQuote } from "../server/session.ts"

/**
 * shellQuote builds the engine launch command line that runs in the worktree,
 * so its quoting is security-relevant: a value must never break out of the
 * quoting to inject extra shell commands.
 */

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
    // a'b → 'a'\''b'  (close, escaped-quote, reopen)
    expect(shellQuote(["a'b"])).toBe("'a'\\''b'")
  })

  it("neutralizes an injection attempt via an embedded quote", () => {
    // A value trying to break out and run `rm -rf /` stays one quoted token.
    const out = shellQuote(["'; rm -rf / #"])
    expect(out).toBe("''\\''; rm -rf / #'")
    // It must NOT contain an unescaped quote that would end the string early
    // and expose `rm` as a bare command — the only bare run is inside quotes.
    expect(out.startsWith("'")).toBe(true)
    expect(out.endsWith("'")).toBe(true)
  })

  it("joins multiple args with single spaces", () => {
    expect(shellQuote(["a", "b c", "d"])).toBe("a 'b c' d")
  })
})
