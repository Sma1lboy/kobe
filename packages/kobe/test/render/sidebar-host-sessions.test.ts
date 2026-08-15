/**
 * The poll's change test — what decides whether a `pty.list` tick reaches the
 * tree at all.
 *
 * It exists because the tab-title projection reads this poll: the host
 * allocates a fresh array every 2s, so without a comparison the sidebar would
 * rebuild every row on a cadence, and with the WRONG comparison a title that
 * moved would never arrive. Both failures are silent in a frame test — one
 * looks like a correct tree, the other like an idle one.
 *
 * Render track because `use-host-sessions` pulls the opentui-side pty client
 * through its import graph, which vitest's node environment can't load.
 */

import { describe, expect, it } from "bun:test"
import { sameSessions } from "../../src/tui-react/panes/sidebar/use-host-sessions"

const S = (key: string, over: { alive?: boolean; title?: string | null } = {}) => ({
  key,
  alive: true,
  title: "claude",
  ...over,
})

describe("sameSessions", () => {
  it("holds a quiet host steady, so an unchanged tick re-renders nothing", () => {
    expect(sameSessions([S("t1::tab-1"), S("t1::tab-2")], [S("t1::tab-1"), S("t1::tab-2")])).toBe(true)
    expect(sameSessions([], [])).toBe(true)
  })

  it("lets a moved title through — the whole reason the tree reads this poll", () => {
    expect(sameSessions([S("t1::tab-1")], [S("t1::tab-1", { title: "fixing the parser" })])).toBe(false)
    // …including a session that has not named itself yet, and one that stops
    // reporting a title at all.
    expect(sameSessions([S("t1::tab-1", { title: "" })], [S("t1::tab-1", { title: "claude" })])).toBe(false)
    expect(sameSessions([S("t1::tab-1")], [S("t1::tab-1", { title: null })])).toBe(false)
  })

  it("reports the session-set changes the orphan backstop reads", () => {
    expect(sameSessions([S("t1::tab-1")], [S("t1::tab-1"), S("t1::tab-2")])).toBe(false)
    expect(sameSessions([S("t1::tab-1")], [S("t2::tab-1")])).toBe(false)
    expect(sameSessions([S("t1::tab-1")], [S("t1::tab-1", { alive: false })])).toBe(false)
    // Same members, different order: the host reordering its inventory is a
    // change the tree may as well take — cheap, and never a missed update.
    expect(sameSessions([S("t1::tab-1"), S("t1::tab-2")], [S("t1::tab-2"), S("t1::tab-1")])).toBe(false)
  })
})
