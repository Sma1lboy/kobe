import { describe, expect, test } from "vitest"
import { quoteShellArg, quoteShellArgv } from "../../src/lib/shell-command"

describe("shell-command quoting", () => {
  test("quotes one arg conservatively by default", () => {
    expect(quoteShellArg("plain")).toBe("'plain'")
    expect(quoteShellArg("it's")).toBe("'it'\\''s'")
  })

  test("can pass simple tokens through bare when requested", () => {
    expect(quoteShellArgv(["claude", "--model", "sonnet"], { bareSafe: true })).toBe("claude --model sonnet")
    expect(quoteShellArgv(["a b", "x;y", "$(whoami)"], { bareSafe: true })).toBe("'a b' 'x;y' '$(whoami)'")
  })

  test("joins conservatively quoted argv values", () => {
    expect(quoteShellArgv(["sh", "-c", "echo a b"])).toBe("'sh' '-c' 'echo a b'")
  })
})
