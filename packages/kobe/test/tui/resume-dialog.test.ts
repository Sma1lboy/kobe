import { describe, expect, test } from "vitest"
import { engineLabel } from "../../src/tui/component/resume-dialog-labels"
import type { SessionMeta } from "../../src/types/engine"

describe("resume dialog helpers", () => {
  test("labels sessions with their owning engine identity", () => {
    const base = {
      sessionId: "sid",
      mtimeMs: 0,
      firstUserMessage: "hello",
      messageCount: 1,
    } satisfies SessionMeta

    expect(engineLabel({ ...base, vendor: "claude" })).toBe("Claude")
    expect(engineLabel({ ...base, vendor: "codex" })).toBe("Codex")
  })
})
