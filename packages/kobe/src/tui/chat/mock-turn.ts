/**
 * `dev:mock-react-chat` fixture — a scripted fake AI SDK harness turn.
 *
 * Framework-free (same seam family as `history/mock-fixtures.ts`): the chat
 * pane takes its turn runner through the injectable `startTurn` prop, and
 * this factory returns a drop-in for `startAiSdkTurn` that streams growing
 * `UIMessage` snapshots on a timer — reasoning, prose, a dynamic tool call
 * resolving to output, then the final summary line — with no engine, tmux,
 * daemon, or worktree involved. `interrupt()` stops the script mid-stream,
 * matching the real turn's abort semantics.
 */

import type { AiSdkTurn, AiSdkTurnOpts } from "@/engine/ai-sdk/harness-turn"
import type { UIMessage } from "ai"

export const MOCK_CHAT_WORKTREE = "/mock/kobe-chat-demo"
export const MOCK_CHAT_PROMPT = "Summarize the mock release notes"
/** Greppable proof line — the dev:mock-react-chat gate asserts this reaches the screen. */
export const MOCK_CHAT_DONE_TEXT = "Mock harness turn complete — release notes summarized."

type Parts = UIMessage["parts"]

/** The scripted snapshot sequence; each entry REPLACES the assistant tail. */
function snapshots(): readonly Parts[] {
  const reasoning: Parts[number] = { type: "reasoning", text: "Scanning the mock release notes fixture…" }
  const prose: Parts[number] = { type: "text", text: "Reading the fixture transcript for highlights." }
  const toolRunning: Parts[number] = {
    type: "dynamic-tool",
    toolName: "Bash",
    toolCallId: "mock-tool-1",
    state: "input-available",
    input: { command: "git log --oneline -3" },
  }
  const toolDone: Parts[number] = {
    type: "dynamic-tool",
    toolName: "Bash",
    toolCallId: "mock-tool-1",
    state: "output-available",
    input: { command: "git log --oneline -3" },
    output: "a1b2c3 feat: mock release entry\nd4e5f6 fix: mock bugfix entry",
  }
  const summary: Parts[number] = { type: "text", text: MOCK_CHAT_DONE_TEXT }
  return [
    [reasoning],
    [reasoning, prose],
    [reasoning, prose, toolRunning],
    [reasoning, prose, toolDone],
    [reasoning, prose, toolDone, summary],
  ]
}

/**
 * Build a fake `startAiSdkTurn`. `stepMs` spaces the snapshots (default
 * 400ms — visible growth inside the 6s dev:mock gate window; tests pass 1ms).
 */
export function createMockStartTurn(stepMs = 400): (opts: AiSdkTurnOpts) => AiSdkTurn {
  return (opts) => {
    const frames = snapshots()
    let timer: ReturnType<typeof setTimeout> | undefined
    let finish: () => void = () => {}
    const done = new Promise<{ error?: never }>((resolve) => {
      finish = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        resolve({})
      }
      let i = 0
      const step = (): void => {
        const parts = frames[i]
        if (!parts) {
          finish()
          return
        }
        i += 1
        opts.onUpdate({ id: "mock-assistant-1", role: "assistant", parts: [...parts] })
        timer = setTimeout(step, stepMs)
      }
      timer = setTimeout(step, stepMs)
    })
    return { done, interrupt: () => finish() }
  }
}
