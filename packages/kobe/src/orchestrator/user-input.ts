import type {
  AskQuestionEntry,
  AskQuestionPayload,
  EngineEvent,
  QuestionOption,
  UserInputPayload,
  UserInputResponse,
} from "@/types/engine"

/**
 * Inspect an engine event to see if it represents a tool that pauses
 * the Session for user input. Returns the typed payload to surface or
 * `null` when the event is uninteresting.
 *
 * We dispatch on `tool.start`: in `claude -p` mode the subprocess
 * cannot actually wait for the user, so surfacing the pause as early
 * as possible keeps the chat Pane visually ahead of the terminal
 * `done` event.
 */
export function detectUserInputFromEngineEvent(ev: EngineEvent): UserInputPayload | null {
  if (ev.type !== "tool.start") return null
  // Both v1 and v2 of ExitPlanMode ship under the same name (see
  // refs/claude-code/src/tools/ExitPlanModeTool/constants.ts).
  if (ev.name === "ExitPlanMode" || ev.name === "ExitPlanModeV2Tool") {
    const input = ev.input
    if (!input || typeof input !== "object") return null
    const obj = input as Record<string, unknown>
    const plan = typeof obj.plan === "string" ? obj.plan : ""
    const filePath = typeof obj.filePath === "string" ? obj.filePath : null
    // Surface even an empty plan: it is a model bug worth showing in
    // the UI rather than silently swallowing.
    return { kind: "approve_plan", plan, filePath }
  }
  if (ev.name === "AskUserQuestion") {
    return parseAskUserQuestionInput(ev.input)
  }
  return null
}

/**
 * Pull a typed AskQuestion payload out of the raw tool input. Defensive:
 * the shape is documented (refs/claude-code/src/tools/AskUserQuestionTool/
 * AskUserQuestionTool.tsx schema) but we tolerate missing optional
 * fields rather than dropping the whole request.
 */
function parseAskUserQuestionInput(input: unknown): AskQuestionPayload | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  if (!Array.isArray(obj.questions)) return null
  const out: AskQuestionEntry[] = []
  for (const q of obj.questions) {
    if (!q || typeof q !== "object") continue
    const qo = q as Record<string, unknown>
    const question = typeof qo.question === "string" ? qo.question : ""
    if (!question) continue
    const header = typeof qo.header === "string" ? qo.header : ""
    const multiSelect = qo.multiSelect === true
    const opts = Array.isArray(qo.options) ? qo.options : []
    const options: QuestionOption[] = []
    for (const o of opts) {
      if (!o || typeof o !== "object") continue
      const oo = o as Record<string, unknown>
      const label = typeof oo.label === "string" ? oo.label : ""
      if (!label) continue
      const description = typeof oo.description === "string" ? oo.description : ""
      options.push({ label, description })
    }
    if (options.length === 0) continue
    out.push({ question, header, multiSelect, options })
  }
  if (out.length === 0) return null
  return { kind: "ask_question", questions: out }
}

/**
 * Build the synthetic user prompt sent on `--resume` after the user
 * answers a pending user-input request. Returns `""` for unhandled
 * response shapes so callers can short-circuit without sending an
 * empty prompt.
 */
export function renderUserInputResponsePrompt(req: UserInputPayload, response: UserInputResponse): string {
  if (req.kind === "approve_plan" && response.kind === "approve_plan") {
    if (response.approve) {
      return "Plan approved. Please proceed with the implementation as outlined."
    }
    return "Plan rejected. Please reconsider the approach and present a revised plan."
  }
  if (req.kind === "ask_question" && response.kind === "ask_question") {
    // Iterate requested questions, not response keys, so unanswered
    // questions remain visible to the model as "(no answer)".
    const lines: string[] = ["You asked:"]
    for (const q of req.questions) {
      const ans = response.answers[q.question]
      lines.push(`- ${q.question} → ${ans && ans.length > 0 ? ans : "(no answer)"}`)
    }
    lines.push("", "Please continue.")
    return lines.join("\n")
  }
  return ""
}
