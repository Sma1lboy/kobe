/**
 * Behavior test for `ClaudeCodeLocal`.
 *
 * Goal: prove the engine plumbs end-to-end — binary lookup, subprocess
 * spawn, stdout parsing, session id capture, event normalization, stop
 * — without burning Anthropic tokens. We override `binaryPathResolver`
 * to point at a fake bash script under `fixtures/`.
 *
 * If this test passes, we know:
 *   1. spawn() resolves with the session id from `system.init`.
 *   2. stream() yields the canonical EngineEvent sequence terminating in `done`.
 *   3. stop() reaps a long-running child cleanly.
 *
 * This test is intentionally NOT a PTY test — `ClaudeCodeLocal` does
 * not need a TTY. We rely on `bun run test:behavior` invoking it under
 * vitest the same way `bun run test` would, but the contract per
 * HARNESS.md §Behavioral self-test holds: it spawns the actual product
 * subprocess and asserts on visible (event) state.
 */

import path from "node:path"
import { ClaudeCodeLocal } from "@/engine/claude-code-local/index"
import type { EngineEvent } from "@/types/engine"
import { describe, expect, it } from "vitest"

const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.sh")
const FAKE_CLAUDE_HANG = path.join(__dirname, "fixtures", "fake-claude-hang.sh")

async function collect(iter: AsyncIterable<EngineEvent>, max = 100): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const ev of iter) {
    out.push(ev)
    if (out.length >= max) break
  }
  return out
}

describe("ClaudeCodeLocal (with fake claude binary)", () => {
  it("spawn resolves with the session id from system.init, stream yields normalized events ending in done", async () => {
    const engine = new ClaudeCodeLocal({
      binaryPathResolver: async () => FAKE_CLAUDE,
    })

    const handle = await engine.spawn(__dirname, "say hi", {
      env: { TERM: "dumb" },
    })

    // The fake binary pins session_id = "fake-session-0001".
    expect(handle.sessionId).toBe("fake-session-0001")
    expect(handle.cwd).toBe(__dirname)

    const events = await collect(engine.stream(handle))

    // Canonical event mapping for the fake binary's lines:
    //   system.init           → onSessionId (no event)
    //   assistant text        → assistant.delta
    //   assistant tool_use    → tool.start
    //   user tool_result      → tool.result
    //   result success+usage  → usage, done
    expect(events).toEqual([
      { type: "assistant.delta", text: "hello from fake claude" },
      { type: "tool.start", name: "Read", input: { path: "/etc/hosts" } },
      { type: "tool.result", name: "Read", output: "127.0.0.1 localhost" },
      { type: "usage", input_tokens: 7, output_tokens: 11 },
      { type: "done" },
    ])
  }, 15_000)

  it("stop reaps a long-running child within the SIGTERM grace", async () => {
    const engine = new ClaudeCodeLocal({
      binaryPathResolver: async () => FAKE_CLAUDE_HANG,
      // Generous-but-bounded grace so a slow CI doesn't false-fail.
      stopGraceMs: 2_000,
    })

    const handle = await engine.spawn(__dirname, "hang", { env: { TERM: "dumb" } })
    expect(handle.sessionId).toBe("fake-session-hang")

    const t0 = Date.now()
    await engine.stop(handle)
    const elapsed = Date.now() - t0

    // The hang script sleeps 60s; if stop() worked we returned far
    // sooner than that. We don't assert a tight upper bound because
    // the OS may take a few hundred ms to reap on slow runners.
    expect(elapsed).toBeLessThan(5_000)

    // After stop, draining the stream is a no-op (handle is gone
    // from the running map; the iterator returns immediately).
    const events = await collect(engine.stream(handle), 5)
    expect(events).toEqual([])
  }, 15_000)
})
