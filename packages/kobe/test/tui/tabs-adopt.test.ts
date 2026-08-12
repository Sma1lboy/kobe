/**
 * Adoption: a live pty session the tab state doesn't list becomes a real tab
 * under its own id, so the sidebar's ⚠ row turns into one the user can open
 * and close.
 */

import { describe, expect, it } from "vitest"
import { adoptTabs } from "../../src/tui/workspace/tabs-adopt"
import { initialTabs } from "../../src/tui/workspace/terminal-tabs-core"

describe("adoptTabs", () => {
  it("adopts the live session's own tab id without disturbing the active tab", () => {
    const next = adoptTabs({ tabs: initialTabs().tabs, activeId: "tab-1", nextOrdinal: 2 }, ["tab-6"])
    expect(next.activeId).toBe("tab-1")
    // Its own id + implied ordinal: the key the host runs it under, and the
    // ordinal the strip labels it by. A minted one would rename the session.
    expect(next.tabs.find((tab) => tab.id === "tab-6")).toMatchObject({ ordinal: 6, spawned: true })
    // Past every adopted ordinal, so the next new tab cannot collide.
    expect(next.nextOrdinal).toBe(7)
  })

  it("is identity-stable when nothing is new — adoption runs off a 2s poll", () => {
    const prev = initialTabs()
    expect(adoptTabs(prev, ["tab-1"])).toBe(prev)
  })
})
