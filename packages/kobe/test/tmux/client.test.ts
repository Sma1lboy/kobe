import { describe, expect, test } from "vitest"
import { tmuxCommandSequence } from "../../src/tmux/client"

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
