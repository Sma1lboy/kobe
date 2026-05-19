import type { ChatRunState } from "@/orchestrator/core"
import { chatRunStateKey } from "@/orchestrator/core"
import {
  AGENTS_GROUP_ORDER,
  computeAgentRows,
  groupAgentRows,
  lastMessagePreview,
  summarizePreview,
} from "@/tui/panes/chat/agents-view-parts"
import type { ChatState } from "@/tui/panes/chat/store"
import type { ChatTab } from "@/types/task"
import { describe, expect, test } from "vitest"

function tab(id: string, seq: number, title?: string): ChatTab {
  return { id, seq, title } as unknown as ChatTab
}

function state(messages: ChatState["messages"], isStreaming = false): ChatState {
  return { messages, isStreaming } as unknown as ChatState
}

const TASK_ID = "t1"

describe("summarizePreview", () => {
  test("collapses whitespace and trims", () => {
    expect(summarizePreview("  hello   world\n\nfoo  ")).toBe("hello world foo")
  })
  test("caps long text with an ellipsis", () => {
    const long = "x".repeat(200)
    const result = summarizePreview(long)
    expect(result.length).toBe(80)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("lastMessagePreview", () => {
  test("prefers the most recent assistant row", () => {
    const s = state([
      { kind: "user", text: "earlier user", ts: "" },
      { kind: "assistant", text: "the answer", ts: "" },
      { kind: "tool", name: "Read", input: {}, done: true, ts: "" },
    ])
    expect(lastMessagePreview(s)).toBe("the answer")
  })
  test("falls back to user row when no assistant has spoken yet", () => {
    const s = state([{ kind: "user", text: "first ask", ts: "" }])
    expect(lastMessagePreview(s)).toBe("first ask")
  })
  test("returns empty for fresh tab", () => {
    expect(lastMessagePreview(state([]))).toBe("")
    expect(lastMessagePreview(undefined)).toBe("")
  })
})

describe("computeAgentRows", () => {
  const tabs: ChatTab[] = [
    tab("a", 1, "feature"),
    tab("b", 2),
    tab("c", 3, "polish"),
  ]
  const runState: ReadonlyMap<string, ChatRunState> = new Map([
    [chatRunStateKey(TASK_ID, "a"), "running"],
    [chatRunStateKey(TASK_ID, "b"), "awaiting_input"],
    // "c" missing -> idle
  ])
  const states = new Map<string, ChatState>([
    ["a", state([{ kind: "assistant", text: "doing work", ts: "" }])],
    ["b", state([{ kind: "user", text: "blocked on you", ts: "" }])],
  ])

  test("maps tabs to grouped buckets and preserves labels", () => {
    const rows = computeAgentRows(TASK_ID, tabs, runState, states, "a")
    expect(rows).toEqual([
      { tabId: "a", label: "feature", state: "running", preview: "doing work", isActive: true },
      { tabId: "b", label: "chat 2", state: "awaiting_input", preview: "blocked on you", isActive: false },
      { tabId: "c", label: "polish", state: "idle", preview: "", isActive: false },
    ])
  })

  test("groupAgentRows emits buckets in attention order, dropping empties", () => {
    const rows = computeAgentRows(TASK_ID, tabs, runState, states, null)
    const grouped = groupAgentRows(rows)
    expect(grouped.map((g) => g.group)).toEqual(["awaiting_input", "running", "idle"])
    expect(AGENTS_GROUP_ORDER).toEqual(["awaiting_input", "running", "idle"])
  })

  test("missing taskId entry in run-state collapses to idle", () => {
    const rows = computeAgentRows(TASK_ID, [tab("z", 9)], new Map(), new Map(), null)
    expect(rows[0]?.state).toBe("idle")
  })

  test("optimistic-running set promotes a tab to running when no real state has landed", () => {
    const optimistic = new Set(["z"])
    const rows = computeAgentRows(TASK_ID, [tab("z", 9)], new Map(), new Map(), null, optimistic)
    expect(rows[0]?.state).toBe("running")
  })

  test("real run-state takes priority over optimistic-running", () => {
    const rs: ReadonlyMap<string, ChatRunState> = new Map([[chatRunStateKey(TASK_ID, "z"), "awaiting_input"]])
    const optimistic = new Set(["z"])
    const rows = computeAgentRows(TASK_ID, [tab("z", 9)], rs, new Map(), null, optimistic)
    expect(rows[0]?.state).toBe("awaiting_input")
  })

  test("ChatState.isStreaming fills the gap between AskUserQuestion answer and resume-turn run-state", () => {
    // Scenario: user just answered an AskUserQuestion. The broker
    // cleared awaiting_input + the engine handle was already stopped,
    // so the run-state map has no entry for this tab — but the resume
    // runTask has fired user.inject, flipping ChatState.isStreaming
    // true. The card must stay in RUNNING, not flicker to IDLE.
    const states = new Map<string, ChatState>([["z", state([], true)]])
    const rows = computeAgentRows(TASK_ID, [tab("z", 9)], new Map(), states, null)
    expect(rows[0]?.state).toBe("running")
  })

  test("awaiting_input wins over isStreaming when both are set", () => {
    const rs: ReadonlyMap<string, ChatRunState> = new Map([[chatRunStateKey(TASK_ID, "z"), "awaiting_input"]])
    const states = new Map<string, ChatState>([["z", state([], true)]])
    const rows = computeAgentRows(TASK_ID, [tab("z", 9)], rs, states, null)
    expect(rows[0]?.state).toBe("awaiting_input")
  })
})
