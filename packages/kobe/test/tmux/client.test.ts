import { describe, expect, test } from "vitest"
import { runTmux, runTmuxCapturing, tmuxCommandSequence } from "../../src/tmux/client"

describe("spawn failure degrades instead of throwing", () => {
  test("runTmuxCapturing resolves to a non-zero empty capture", async () => {
    await expect(runTmuxCapturing(["display-message", "-p", "x"])).resolves.toEqual({ code: 1, stdout: "" })
  })

  test("runTmux resolves to a non-zero exit code", async () => {
    await expect(runTmux(["display-message", "-p", "x"])).resolves.toBe(1)
  })
})

describe("tmuxCommandSequence", () => {
  test("joins commands with tmux command separators", () => {
    expect(
      tmuxCommandSequence([
        ["set-option", "-g", "status", "on"],
        ["bind-key", "-n", "C-q", "detach-client"],
      ]),
    ).toEqual(["set-option", "-g", "status", "on", ";", "bind-key", "-n", "C-q", "detach-client"])
  })

  test("skips empty commands", () => {
    expect(tmuxCommandSequence([[], ["display-message", "ready"], []])).toEqual(["display-message", "ready"])
  })
})
