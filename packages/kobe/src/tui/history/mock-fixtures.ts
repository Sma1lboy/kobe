import type { EngineHistoryReader } from "@/engine/registry"
import type { Message } from "@/types/engine"

export const MOCK_HISTORY_SESSION_ID = "mock-session"
export const MOCK_HISTORY_WORKTREE = "/mock/worktree"

export function seedHistoryMessages(): Message[] {
  const ts = new Date().toISOString()
  return [
    {
      role: "user",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: ts,
      blocks: [{ type: "text", text: "帮我给 history pane 加一个实时刷新的预览" }],
    },
    {
      role: "assistant",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: ts,
      usage: { input_tokens: 1240, output_tokens: 356 },
      blocks: [
        {
          type: "thinking",
          text: "The read-only history pane should tail the transcript. Reuse the Ops pane's adaptive mtime poll instead of a new file watcher.",
        },
        { type: "text", text: "好的，我复用 Ops pane 的 mtime 轮询，把 HistoryScreen 做成 live。先看现有 effect……" },
        { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "src/tui/history/host.tsx" } },
      ],
    },
    {
      role: "user",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: ts,
      blocks: [{ type: "tool_result", callId: "c1", output: "…file contents…", isError: false }],
    },
    {
      role: "assistant",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: ts,
      usage: { input_tokens: 2010, output_tokens: 128 },
      blocks: [
        {
          type: "tool_call",
          callId: "c2",
          name: "Edit",
          input: { file_path: "host.tsx", old_string: "…", new_string: "…" },
        },
        {
          type: "text",
          text: `A deliberately long line to check wrapping and tail-truncation in the transcript view — ${"lorem ipsum dolor sit amet ".repeat(16)}`,
        },
      ],
    },
    {
      role: "user",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: ts,
      blocks: [{ type: "tool_result", callId: "c2", output: "File updated", isError: false }],
    },
  ]
}

export function createMockHistoryReader(): EngineHistoryReader {
  const grown = seedHistoryMessages()
  let mtime = 1000
  let n = 0
  const timer = setInterval(() => {
    n += 1
    grown.push({
      role: "assistant",
      sessionId: MOCK_HISTORY_SESSION_ID,
      timestamp: new Date().toISOString(),
      blocks: [{ type: "text", text: `实时追加的第 ${n} 条消息 —— mtime 前进触发 refetch` }],
    })
    if (grown.length > 500) grown.splice(0, grown.length - 500)
    mtime += 1
  }, 2500)
  timer.unref?.()
  return {
    async listSessionIdsForWorktree() {
      return ["mock-session-old", MOCK_HISTORY_SESSION_ID]
    },
    async readHistory(id) {
      return id === MOCK_HISTORY_SESSION_ID ? grown.slice() : seedHistoryMessages().slice(0, 2)
    },
    async latestTranscriptMtimeForWorktree() {
      return mtime
    },
  }
}
