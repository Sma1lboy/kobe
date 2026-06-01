/**
 * Origin-ChatTab auto-naming (KOB). Drives `renameOriginChatTab` with a
 * fake TmuxRunner so the window-selection + manual-rename guard logic is
 * tested without a live tmux server (those live in the behavior suite).
 */

import { describe, expect, it } from "vitest"
import { type TmuxRunner, renameOriginChatTab } from "../../src/tmux/chat-tab-naming.ts"

/** Records tmux argv and replies from a scripted map keyed by the command. */
function fakeRunner(replies: {
  windows?: { code: number; stdout: string }
  autoRename?: { code: number; stdout: string }
  renameCode?: number
}): { runner: TmuxRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: TmuxRunner = {
    async capture(args) {
      calls.push(args)
      if (args[0] === "list-windows") return replies.windows ?? { code: 0, stdout: "" }
      if (args[0] === "show-window-options") return replies.autoRename ?? { code: 0, stdout: "" }
      return { code: 1, stdout: "" }
    },
    async run(args) {
      calls.push(args)
      return replies.renameCode ?? 0
    },
  }
  return { runner, calls }
}

describe("renameOriginChatTab", () => {
  it("renames the lowest-index window (base-index 1, ignores higher tabs)", async () => {
    const { runner, calls } = fakeRunner({ windows: { code: 0, stdout: "3\n1\n2\n" } })

    const ok = await renameOriginChatTab("01TASK", "你好吗", runner)

    expect(ok).toBe(true)
    const rename = calls.find((c) => c[0] === "rename-window")
    expect(rename).toEqual(["rename-window", "-t", "=kobe-01TASK:1", "--", "你好吗"])
  })

  it("skips a window already named manually (automatic-rename off)", async () => {
    const { runner, calls } = fakeRunner({
      windows: { code: 0, stdout: "1\n" },
      autoRename: { code: 0, stdout: "automatic-rename off\n" },
    })

    const ok = await renameOriginChatTab("01TASK", "Derived", runner)

    expect(ok).toBe(false)
    expect(calls.some((c) => c[0] === "rename-window")).toBe(false)
  })

  it("proceeds when automatic-rename is inherited (empty option output)", async () => {
    const { runner } = fakeRunner({
      windows: { code: 0, stdout: "1\n" },
      autoRename: { code: 0, stdout: "" },
    })
    expect(await renameOriginChatTab("01TASK", "Derived", runner)).toBe(true)
  })

  it("no-ops when the session is gone (list-windows fails)", async () => {
    const { runner, calls } = fakeRunner({ windows: { code: 1, stdout: "" } })
    expect(await renameOriginChatTab("01TASK", "Derived", runner)).toBe(false)
    expect(calls.some((c) => c[0] === "rename-window")).toBe(false)
  })

  it("no-ops on an empty title without touching tmux", async () => {
    const { runner, calls } = fakeRunner({})
    expect(await renameOriginChatTab("01TASK", "   ", runner)).toBe(false)
    expect(calls).toEqual([])
  })
})
