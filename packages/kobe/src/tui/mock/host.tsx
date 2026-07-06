/**
 * `dev:mock` host — render a REAL kobe pane against FAKE data.
 *
 * `bun run dev:mock` boots a real pane component (the live history preview) with
 * a synthetic, growing transcript — no engine, tmux, daemon, worktree, or
 * `~/.kobe` involved. It's for eyeballing UI + interaction fast (theme, layout,
 * CJK, long lines, the live tail) without the dev:sandbox round-trip.
 *
 * How it works: the pane hosts take their transcript through an injectable
 * `EngineHistoryReader` (see history/host.tsx). Here we pass a fake reader whose
 * message list grows on a timer + advances its mtime, so the pane's own mtime
 * poll refetches and you watch the transcript tail live.
 *
 * To mock another pane, add a branch to `startMockHost` (each pane host already
 * takes its data via a narrow seam — inject a fake the same way).
 */

import type { EngineHistoryReader } from "@/engine/registry"
import type { Message } from "@/types/engine"
import { coerceVendorId } from "@/types/vendor"
import { startHistoryHost } from "../history/host"

const SID = "mock-session"

/** A representative starter transcript exercising every block renderer. */
function seedMessages(): Message[] {
  const ts = new Date().toISOString()
  return [
    {
      role: "user",
      sessionId: SID,
      timestamp: ts,
      blocks: [{ type: "text", text: "帮我给 history pane 加一个实时刷新的预览" }],
    },
    {
      role: "assistant",
      sessionId: SID,
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
      sessionId: SID,
      timestamp: ts,
      blocks: [{ type: "tool_result", callId: "c1", output: "…file contents…", isError: false }],
    },
    {
      role: "assistant",
      sessionId: SID,
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
      sessionId: SID,
      timestamp: ts,
      blocks: [{ type: "tool_result", callId: "c2", output: "File updated", isError: false }],
    },
  ]
}

/** A fake reader whose transcript grows on a timer to demo the live tail. */
function mockReader(): EngineHistoryReader {
  const grown = seedMessages()
  let mtime = 1000
  let n = 0
  // Append an assistant turn + advance mtime every few seconds; the pane's mtime
  // poll then refetches and the new message appears — the live-tail demo.
  const timer = setInterval(() => {
    n += 1
    grown.push({
      role: "assistant",
      sessionId: SID,
      timestamp: new Date().toISOString(),
      blocks: [{ type: "text", text: `实时追加的第 ${n} 条消息 —— mtime 前进触发 refetch` }],
    })
    // Cap the fake transcript so a mock left running for days stays bounded.
    if (grown.length > 500) grown.splice(0, grown.length - 500)
    mtime += 1
  }, 2500)
  timer.unref?.()
  return {
    // Two sessions so `[` / `]` session switching is exercisable.
    async listSessionIdsForWorktree() {
      return ["mock-session-old", SID]
    },
    async readHistory(id) {
      return id === SID ? grown.slice() : seedMessages().slice(0, 2)
    },
    async latestTranscriptMtimeForWorktree() {
      return mtime
    },
  }
}

export async function startMockHost(): Promise<void> {
  await startHistoryHost({
    worktree: "/mock/worktree",
    vendor: coerceVendorId("claude"),
    live: true,
    reader: mockReader(),
  })
}

void startMockHost()
