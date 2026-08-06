import { afterEach, describe, expect, it } from "vitest"
import { terminalTabsKey } from "../../src/tui-react/workspace/terminal-tabs-persist"
import {
  appendForkTabState,
  appendTaskForkTab,
  requestTabActivation,
  tabsByTask,
  takeTabActivation,
} from "../../src/tui-react/workspace/terminal-tabs-shared"
import { initialTabs, setTabSessionId } from "../../src/tui/workspace/terminal-tabs-core"

function fakeKv(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  return {
    store,
    set(key: string, value: unknown) {
      store[key] = value
    },
  }
}

afterEach(() => tabsByTask.clear())

describe("agent channel tab endpoints", () => {
  it("appends an unspawned native fork and preserves the original tab", () => {
    const original = setTabSessionId(initialTabs(), "tab-1", "source-session")
    const { state, tab } = appendForkTabState(original, { vendor: "codex", sourceSessionId: "source-session" })

    expect(state.tabs[0]).toEqual(original.tabs[0])
    expect(tab).toMatchObject({
      id: "tab-2",
      kind: "engine",
      vendor: "codex",
      forkFrom: "source-session",
    })
    expect(tab.spawned).not.toBe(true)
    expect(state.activeId).toBe("tab-2")
  })

  it("writes a background task endpoint to live and persisted state", () => {
    const kv = fakeKv()
    const { tab } = appendTaskForkTab(kv, "task-b", "/bin/zsh", {
      vendor: "claude",
      sourceSessionId: "claude-source",
    })

    expect(tab).toMatchObject({ id: "tab-2", forkFrom: "claude-source" })
    expect(tab.spawned).not.toBe(true)
    // A user command carrying Claude's `-c` session-control flag cannot be
    // assigned a caller UUID; the fork still gets its engine-generated id.
    expect(typeof tab.sessionId !== "string" || /^[0-9a-f-]{36}$/.test(tab.sessionId)).toBe(true)
    expect(tabsByTask.get("task-b")?.activeId).toBe(tab.id)
    expect(kv.store[terminalTabsKey("task-b")]).toEqual(tabsByTask.get("task-b"))
  })

  it("queues endpoint activation independently for both channel sides", () => {
    requestTabActivation("task-a", "tab-2")
    requestTabActivation("task-b", "tab-4")
    expect(takeTabActivation("task-a")).toBe("tab-2")
    expect(takeTabActivation("task-b")).toBe("tab-4")
  })
})
