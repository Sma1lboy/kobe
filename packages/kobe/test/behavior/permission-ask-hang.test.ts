/**
 * KOB-4 Repro: Permission Request Event Handling
 *
 * Investigates whether a hypothetical `permission_request` stream-json
 * event would cause kobe's chat pane to freeze/hang.
 *
 * Background:
 *   - KOB-17 (commit 41e1f74) made kobe's `default` permission mode map
 *     to claude's `bypassPermissions` at spawn, so Claude no longer emits
 *     `permission_request` in default mode.
 *   - In `plan` mode, Claude *could* emit permission_request events.
 *   - The parser (packages/kobe/src/engine/claude-code-local/stream.ts)
 *     does NOT handle `permission_request` events — they're silently dropped
 *     as "unknown shape" (line 186–187).
 *   - The chat reducer (applyEvent in packages/kobe/src/tui/panes/chat/store.ts)
 *     handles only a fixed set of OrchestratorEvent types. Unknown types
 *     hit the default case and return state unchanged (line 569–570).
 *   - The SessionPump (packages/kobe/src/orchestrator/session-pump.ts) only
 *     detects pause tools via detectUserInputFromEngineEvent, which only
 *     looks at `tool.start` events with specific tool names.
 *
 * Hypothesis:
 *   If the parser emitted a hypothetical `permission_request` EngineEvent
 *   (e.g., { type: "permission_request", ... }), it would:
 *   1. NOT be detected as a pause-tool by the pump.
 *   2. Be dispatched to the chat pane as an OrchestratorEvent.
 *   3. NOT match any case in the chat reducer's switch, hitting default.
 *   4. Result in state unchanged, so the event appears to vanish.
 *
 * Test:
 *   Script the fake engine to emit a hypothetical permission_request
 *   EngineEvent (not a valid Claude event, but a hypothetical future one)
 *   and observe whether the chat pane silently swallows it.
 *
 * Status: SKIPPED for now — this is a documentation test.
 * The actual bug would only manifest if Claude Code emitted permission_request
 * in the stream-json, which it currently does not (KOB-17 made it skip them).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { EngineEvent } from "../../src/types/engine"
import { createInitialState, applyEvent } from "../../src/tui/panes/chat/store"
import { SessionPump } from "../../src/orchestrator/session-pump"
import { FakeAIEngine } from "./fake-engine"

describe("KOB-4: Permission Request Event Handling", () => {
  let engine: FakeAIEngine

  beforeEach(() => {
    engine = new FakeAIEngine()
  })

  afterEach(() => {
    engine.reset()
  })

  it.skip(
    "hypothetical permission_request EngineEvent would be silently dropped by chat reducer",
    async () => {
      // This test demonstrates what would happen if the parser ever
      // emitted a permission_request event (currently impossible — the
      // parser has no case for it, so it would be dropped at parse time).
      //
      // The test is skipped because:
      //   1. The parser would drop it before the chat pane ever sees it.
      //   2. We can't realistically script a permission_request from
      //      Claude Code because it doesn't emit them in stream-json.
      //   3. This is a "type safety" test — if someone adds a permission_request
      //      event type to EngineEvent in the future, this test serves as
      //      documentation that the event would be silently lost.

      // Hypothetical permission_request event (not currently emitted by Claude).
      // If the parser ever had a case for it, it would look like this:
      const hypotheticalEvent: EngineEvent & { type: "permission_request" } = {
        type: "permission_request" as any,
        toolName: "Edit",
        filePath: "/path/to/file",
        explanation: "File write permission requested",
      } as any

      // Verify the chat reducer has no case for this event.
      // Applying it to chat state should return state unchanged.
      const state = createInitialState()
      const nextState = applyEvent(state, hypotheticalEvent as any)

      expect(nextState).toBe(state)
      expect(state.messages.length).toBe(0)
      // Event is silently lost.
    },
  )

  it.skip(
    "parser silently drops unknown top-level stream-json types (including hypothetical permission_request)",
    () => {
      // The parseStreamJson function (packages/kobe/src/engine/claude-code-local/stream.ts)
      // handles these top-level types:
      //   - system (subtype: init) → onSessionId callback, no EngineEvent
      //   - assistant → tool.start or assistant.delta
      //   - user → tool.result
      //   - result → usage or done/error
      //   - anything else → dropped silently (line 186–187)
      //
      // If Claude Code were to emit { type: "permission_request", ... }
      // at the top level, it would be silently dropped and never reach
      // the orchestrator or chat pane.
      //
      // To verify this behavior, we would need to:
      //   1. Instrument parseStreamJson to log dropped events.
      //   2. Emit a malformed stream-json line.
      //   3. Assert the event was dropped.
      //
      // Since we can't control what Claude Code emits in the stream-json,
      // this test is deferred. The fix (if we ever need permission_request
      // events) would be to:
      //   1. Add `| { type: "permission_request"; ... }` to EngineEvent.
      //   2. Add a case in parseStreamJson to detect and emit it.
      //   3. Add a case in applyEvent (chat reducer) to handle it.
      //   4. Optionally add detection in SessionPump if the event should
      //      pause the session (like ExitPlanMode).

      expect(true).toBe(true)
    },
  )

  it.skip(
    "SessionPump.run would not pause for a hypothetical permission_request",
    async () => {
      // SessionPump's pause-tool detection is specific to tool.start
      // events with known tool names (ExitPlanMode, AskUserQuestion).
      // A permission_request event (even if it reached the pump) would
      // not be detected as a pause, so the session would continue
      // streaming. This is the hang scenario:
      //
      //   1. Pump emits permission_request to subscribers.
      //   2. Chat pane receives it, unknown type → default case → ignored.
      //   3. No UI affordance (no approval banner).
      //   4. Session continues running.
      //   5. From the user's perspective, the subprocess is still going
      //      but there's no way to interact with the permission prompt.
      //      If the subprocess is waiting for user input (a permission
      //      yes/no), the subprocess hangs waiting for the user, and the
      //      chat pane hangs because the pump is blocked on subprocess I/O.
      //      The user has no UI to approve, so they're stuck.

      // Documented but not tested, since the parser drops permission_request
      // before the pump ever sees it.

      expect(true).toBe(true)
    },
  )
})
