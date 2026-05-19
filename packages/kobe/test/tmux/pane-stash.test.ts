/**
 * Unit tests for `createPaneStash` — the pure (taskId, tabId) → paneId
 * state machine that drives the chat-slot swap. Every test exercises a
 * single transition and asserts on the returned ops + observable state,
 * never on tmux itself.
 */

import { describe, expect, it } from "vitest"
import {
  PaneStashError,
  PaneStashNotAttachedError,
  type TmuxOp,
  createPaneStash,
} from "../../src/tmux/pane-stash.ts"

const ATTACH = {
  stashWindow: "stash",
  chatSlotPaneId: "%10",
  savedLayout: "abc,80x24,0,0,1",
} as const

describe("createPaneStash — lifecycle", () => {
  it("starts detached and flips on attach()", () => {
    const stash = createPaneStash()
    expect(stash.isAttached()).toBe(false)
    stash.attach({ ...ATTACH })
    expect(stash.isAttached()).toBe(true)
  })

  it("detach() forgets the tmux session entirely", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.detach()
    expect(stash.isAttached()).toBe(false)
    expect(() => stash.planSpawn("t", "tab", "cmd")).toThrow(PaneStashNotAttachedError)
  })

  it("mutators throw PaneStashNotAttachedError before attach()", () => {
    const stash = createPaneStash()
    expect(() => stash.planSpawn("t", "tab", "cmd")).toThrow(PaneStashNotAttachedError)
    expect(() => stash.registerPane("t", "tab", "%1")).toThrow(PaneStashNotAttachedError)
    expect(() => stash.planSwap("t", "tab")).toThrow(PaneStashNotAttachedError)
    expect(() => stash.planKill("t", "tab")).toThrow(PaneStashNotAttachedError)
  })

  it("readers return null/empty before attach()", () => {
    const stash = createPaneStash()
    expect(stash.getDisplayed()).toBeNull()
    expect(stash.getPaneId("t", "tab")).toBeNull()
  })
})

describe("createPaneStash — planSpawn / registerPane", () => {
  it("planSpawn returns one spawn op tagged with (taskId, tabId)", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    const ops = stash.planSpawn("task-A", "tab-1", "exec claude")
    expect(ops).toEqual<TmuxOp[]>([
      {
        kind: "spawn",
        window: "stash",
        command: "exec claude",
        opaque: { taskId: "task-A", tabId: "tab-1" },
      },
    ])
  })

  it("registerPane records the pane id retrievable via getPaneId", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.planSpawn("task-A", "tab-1", "exec claude")
    expect(stash.getPaneId("task-A", "tab-1")).toBeNull()
    stash.registerPane("task-A", "tab-1", "%42")
    expect(stash.getPaneId("task-A", "tab-1")).toBe("%42")
  })
})

describe("createPaneStash — planSwap", () => {
  it("with nothing displayed → single swap-into-chat op with oldPaneId:null", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.registerPane("task-A", "tab-1", "%42")
    const ops = stash.planSwap("task-A", "tab-1")
    expect(ops).toEqual<TmuxOp[]>([
      {
        kind: "swap-into-chat",
        newPaneId: "%42",
        oldPaneId: null,
        chatSlotPaneId: "%10",
        stashWindow: "stash",
        savedLayout: ATTACH.savedLayout,
      },
    ])
    expect(stash.getDisplayed()).toEqual({ taskId: "task-A", tabId: "tab-1", paneId: "%42" })
  })

  it("when the target pane is already displayed → empty op list", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.registerPane("task-A", "tab-1", "%42")
    stash.planSwap("task-A", "tab-1") // first swap, makes %42 active
    expect(stash.planSwap("task-A", "tab-1")).toEqual([])
  })

  it("with another pane displayed → swap-into-chat with previous paneId as oldPaneId", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.registerPane("task-A", "tab-1", "%42")
    stash.registerPane("task-A", "tab-2", "%43")
    stash.planSwap("task-A", "tab-1") // displays %42
    const ops = stash.planSwap("task-A", "tab-2")
    expect(ops).toHaveLength(1)
    const op = ops[0]
    expect(op?.kind).toBe("swap-into-chat")
    if (op?.kind !== "swap-into-chat") throw new Error("expected swap-into-chat op")
    expect(op.newPaneId).toBe("%43")
    expect(op.oldPaneId).toBe("%42")
    // chatSlotPaneId tracks the previously-displayed pane (it became the chat slot after the prior swap).
    expect(op.chatSlotPaneId).toBe("%42")
    // Displayed state now reflects the new pane.
    expect(stash.getDisplayed()).toEqual({ taskId: "task-A", tabId: "tab-2", paneId: "%43" })
  })

  it("throws when no pane has been registered for the target (taskId, tabId)", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    expect(() => stash.planSwap("task-A", "tab-1")).toThrow(PaneStashError)
  })
})

describe("createPaneStash — planKill", () => {
  it("on a stashed (not-displayed) pane → kill-pane op + drops the map entry", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.registerPane("task-A", "tab-1", "%42")
    const ops = stash.planKill("task-A", "tab-1")
    expect(ops).toEqual<TmuxOp[]>([{ kind: "kill-pane", paneId: "%42" }])
    expect(stash.getPaneId("task-A", "tab-1")).toBeNull()
  })

  it("on an unknown (taskId, tabId) → empty op list (idempotent)", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    expect(stash.planKill("nope", "nope")).toEqual([])
  })

  it("on the displayed pane → throws (caller must swap first)", () => {
    const stash = createPaneStash()
    stash.attach({ ...ATTACH })
    stash.registerPane("task-A", "tab-1", "%42")
    stash.planSwap("task-A", "tab-1") // displays %42
    expect(() => stash.planKill("task-A", "tab-1")).toThrow(PaneStashError)
    // Map entry should still be present because the kill was rejected.
    expect(stash.getPaneId("task-A", "tab-1")).toBe("%42")
  })
})
