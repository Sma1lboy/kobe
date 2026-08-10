/**
 * The live-engine store is what replaced OSC-title sniffing as kobe's
 * process identity (a claude session whose summary said "codex" used to
 * relabel its tab codex). These lock the two properties the fix depends
 * on: identity comes from the tree under the tab's OWN shell pid, and it
 * is released the moment that process is gone.
 */

import { describe, expect, it } from "vitest"
import type { TaskPtyLike } from "../../src/tui/panes/terminal/pty-types"
import { createLiveEngines } from "../../src/tui/workspace/live-engine"

const pty = (shellPid: number | null): TaskPtyLike => ({ shellPid }) as unknown as TaskPtyLike

/** tab A's shell runs claude (under cc-switch's sh wrapper); tab B idles. */
const TREE = `
100 1 -zsh
101 100 /bin/sh -c claude_bin="$1"; settings_path="$2"
102 101 /opt/homebrew/bin/claude --model claude-opus-5[1m]
200 1 -zsh
`
const IDLE = `
100 1 -zsh
200 1 -zsh
`

describe("createLiveEngines", () => {
  it("identifies the engine under each tab's own shell, and only that tab's", async () => {
    const store = createLiveEngines({
      entries: () => [
        ["a", pty(100)],
        ["b", pty(200)],
      ],
      snapshot: async () => TREE,
    })
    await store.probe()
    expect(store.get("a")).toBe("claude")
    expect(store.get("b")).toBeNull()
    store.dispose()
  })

  it("releases the identity when the engine exits back to the prompt", async () => {
    let tree = TREE
    const store = createLiveEngines({ entries: () => [["a", pty(100)]], snapshot: async () => tree })
    await store.probe()
    expect(store.get("a")).toBe("claude")

    tree = IDLE
    let notified = 0
    store.subscribe(() => notified++)
    await store.probe()
    expect(store.get("a")).toBeNull()
    expect(notified).toBe(1)
    store.dispose()
  })

  it("drops identity for a PTY that vanished or never spawned a child", async () => {
    let live: readonly (readonly [string, TaskPtyLike])[] = [["a", pty(100)]]
    const store = createLiveEngines({ entries: () => live, snapshot: async () => TREE })
    await store.probe()
    expect(store.get("a")).toBe("claude")

    live = [["a", pty(null)]] // mock/unspawned PTY — nothing to walk
    await store.probe()
    expect(store.get("a")).toBeNull()

    live = []
    await store.probe()
    expect(store.get("a")).toBeNull()
    store.dispose()
  })

  it("resolve() is tri-state: vendor / confirmed-none / can't-look", async () => {
    let tree = TREE
    let live: readonly (readonly [string, TaskPtyLike])[] = [
      ["a", pty(100)],
      ["b", pty(200)],
      ["c", pty(null)], // attached but unspawned — nothing to walk
    ]
    const store = createLiveEngines({ entries: () => live, snapshot: async () => tree })
    await store.probe()
    expect(store.resolve("a")).toBe("claude") // engine live
    expect(store.resolve("b")).toBeNull() // shell walked, confirmed engine-free
    expect(store.resolve("c")).toBeUndefined() // can't look
    expect(store.resolve("never-seen")).toBeUndefined()

    // The engine exits (ctrl+C back to the prompt): a is now CONFIRMED empty,
    // not unknown — recorded identity must not resurrect through it.
    tree = IDLE
    await store.probe()
    expect(store.resolve("a")).toBeNull()

    // The PTY detaches entirely → back to "can't look".
    live = []
    await store.probe()
    expect(store.resolve("a")).toBeUndefined()
    store.dispose()
  })

  it("keeps the last identity when ps fails — never guesses", async () => {
    let fail = false
    const store = createLiveEngines({
      entries: () => [["a", pty(100)]],
      snapshot: async () => {
        if (fail) throw new Error("ps: cannot fork")
        return TREE
      },
    })
    await store.probe()
    fail = true
    await store.probe()
    expect(store.get("a")).toBe("claude")
    store.dispose()
  })
})
