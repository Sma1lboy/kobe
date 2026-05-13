import type { UserInputResponse } from "../../../types/engine"
import type { ChatRow, ChatState } from "./store"

export type PendingInputRow = Extract<ChatRow, { kind: "approval" | "question" }>
export type PendingApprovalRow = Extract<ChatRow, { kind: "approval" }>
export type PendingQuestionRow = Extract<ChatRow, { kind: "question" }>

export interface PendingInputPaneState {
  readonly pending: PendingInputRow | null
  readonly approval: PendingApprovalRow | null
  readonly question: PendingQuestionRow | null
  readonly blocksPromptDispatch: boolean
  readonly locksComposer: boolean
  readonly showsComposer: boolean
  readonly composerPlaceholder: string | undefined
  readonly composerDisabledMessage: string | undefined
}

const QUESTION_FREE_TEXT_PLACEHOLDER = "Type your own answer or pick an option above..."
const APPROVAL_LOCK_MESSAGE = "(answer the prompt above to continue)"

export function pendingInputPaneState(state: ChatState): PendingInputPaneState {
  const pending = findPendingInput(state)
  const approval = pending?.kind === "approval" ? pending : null
  const question = pending?.kind === "question" ? pending : null
  const locksComposer = approval !== null
  return {
    pending,
    approval,
    question,
    blocksPromptDispatch: pending !== null,
    locksComposer,
    showsComposer: true,
    composerPlaceholder: question ? QUESTION_FREE_TEXT_PLACEHOLDER : undefined,
    composerDisabledMessage: locksComposer ? APPROVAL_LOCK_MESSAGE : undefined,
  }
}

export function findPendingInput(state: ChatState): PendingInputRow | null {
  const msgs = state.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m) continue
    if (m.kind === "approval") return m.status === "pending" ? m : null
    if (m.kind === "question") return m.answers === null ? m : null
    if (m.kind === "user" || m.kind === "assistant" || m.kind === "bash") return null
  }
  return null
}

export function answerQuestionWithFreeText(row: PendingQuestionRow, text: string): UserInputResponse {
  const answers: Record<string, string> = {}
  for (const entry of row.questions) {
    answers[entry.question] = text
  }
  return { kind: "ask_question", answers }
}
