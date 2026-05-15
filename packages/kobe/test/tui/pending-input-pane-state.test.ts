import { describe, expect, test } from "vitest"
import {
  answerQuestionWithFreeText,
  findPendingInput,
  pendingInputPaneState,
} from "../../src/tui/panes/chat/pending-input-pane-state"
import type { ChatState } from "../../src/tui/panes/chat/row-types"
import { createInitialState } from "../../src/tui/panes/chat/store"

const TS = "2026-05-13T00:00:00.000Z"

function withMessages(messages: ChatState["messages"]): ChatState {
  return { ...createInitialState(), messages }
}

describe("pendingInputPaneState", () => {
  test("locks the composer for a pending approval", () => {
    const row = {
      kind: "approval" as const,
      requestId: "req-1",
      tool: "ExitPlanMode" as const,
      plan: "Plan text",
      filePath: null,
      status: "pending" as const,
      ts: TS,
    }
    const state = pendingInputPaneState(withMessages([row]))

    expect(state.pending).toBe(row)
    expect(state.approval).toBe(row)
    expect(state.question).toBeNull()
    expect(state.blocksPromptDispatch).toBe(true)
    expect(state.locksComposer).toBe(true)
    expect(state.showsComposer).toBe(true)
    expect(state.composerDisabledMessage).toBe("(answer the prompt above to continue)")
  })

  test("keeps the composer available for a pending question free-text answer", () => {
    const row = {
      kind: "question" as const,
      requestId: "req-2",
      questions: [
        {
          question: "Which library?",
          header: "Library",
          multiSelect: false,
          options: [{ label: "date-fns", description: "" }],
        },
      ],
      answers: null,
      ts: TS,
    }
    const state = pendingInputPaneState(withMessages([row]))

    expect(state.pending).toBe(row)
    expect(state.approval).toBeNull()
    expect(state.question).toBe(row)
    expect(state.blocksPromptDispatch).toBe(true)
    expect(state.locksComposer).toBe(false)
    expect(state.showsComposer).toBe(true)
    expect(state.composerPlaceholder).toContain("Type your own answer")
    expect(state.composerDisabledMessage).toBeUndefined()
  })

  test("stops scanning once the conversation has moved past the picker", () => {
    const state = withMessages([
      {
        kind: "question" as const,
        requestId: "req-2",
        questions: [],
        answers: null,
        ts: TS,
      },
      { kind: "assistant" as const, text: "already continued", ts: TS },
    ])

    expect(findPendingInput(state)).toBeNull()
    expect(pendingInputPaneState(state).blocksPromptDispatch).toBe(false)
  })

  test("shapes composer free text into an AskUserQuestion response for every question", () => {
    const row = {
      kind: "question" as const,
      requestId: "req-3",
      questions: [
        { question: "Library?", header: "Lib", multiSelect: false, options: [] },
        { question: "Style?", header: "Style", multiSelect: false, options: [] },
      ],
      answers: null,
      ts: TS,
    }

    expect(answerQuestionWithFreeText(row, "use built-ins")).toEqual({
      kind: "ask_question",
      answers: {
        "Library?": "use built-ins",
        "Style?": "use built-ins",
      },
    })
  })
})
