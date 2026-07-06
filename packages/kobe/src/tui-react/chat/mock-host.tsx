/** @jsxImportSource @opentui/react */
/**
 * React chat-pane mock host (`bun run dev:mock-react-chat`) — renders the
 * ported pane against the scripted fake harness turn in
 * `src/tui/chat/mock-turn.ts`: the pane auto-submits the fixture prompt on
 * mount and the fake `startTurn` streams growing UIMessage snapshots
 * (reasoning → prose → tool call → final summary). No engine, tmux, daemon,
 * or worktree involved; the composer stays fully interactive.
 */

import { MOCK_CHAT_PROMPT, MOCK_CHAT_WORKTREE, createMockStartTurn } from "../../tui/chat/mock-turn"
import { bootPaneHost } from "../lib/host-boot"
import { ChatPane } from "./chat-pane"

await bootPaneHost({
  setup: () => ({
    root: () => (
      <ChatPane
        worktree={MOCK_CHAT_WORKTREE}
        title="mock chat"
        vendor="claude"
        startTurn={createMockStartTurn()}
        initialPrompt={MOCK_CHAT_PROMPT}
      />
    ),
  }),
})
