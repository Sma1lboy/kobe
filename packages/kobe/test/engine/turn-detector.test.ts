import { describe, expect, test } from "vitest"
import {
  createEngineTurnDetector,
  latestClaudeCompletionMarkerFromJsonl,
  latestCodexCompletionMarkerFromJsonl,
} from "../../src/engine/turn-detector"

describe("latestCodexCompletionMarkerFromJsonl", () => {
  test("uses turn.completed as the completion marker", () => {
    const raw = [
      JSON.stringify({ type: "response_item", timestamp: "2026-05-29T01:00:00.000Z" }),
      JSON.stringify({ type: "turn.completed", timestamp: "2026-05-29T01:00:03.000Z", usage: { input_tokens: 1 } }),
    ].join("\n")
    const marker = latestCodexCompletionMarkerFromJsonl(raw, "rollout")
    expect(marker?.source).toBe("codex")
    expect(marker?.timestampMs).toBe(Date.parse("2026-05-29T01:00:03.000Z"))
  })
})

describe("latestClaudeCompletionMarkerFromJsonl", () => {
  test("uses assistant transcript records as completion markers", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-29T01:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-29T01:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n")
    const marker = latestClaudeCompletionMarkerFromJsonl(raw, "session")
    expect(marker?.source).toBe("claude")
    expect(marker?.timestampMs).toBe(Date.parse("2026-05-29T01:00:04.000Z"))
  })
})

describe("createEngineTurnDetector", () => {
  test("keeps unsupported vendors behind the same abstraction", () => {
    const detector = createEngineTurnDetector("copilot")
    expect(detector.vendor).toBe("copilot")
    expect(detector.supportsCompletionMarkers()).toBe(false)
  })
})
