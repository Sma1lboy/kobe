import { spawnSync } from "node:child_process"
import { CodexLocal } from "@/engine/codex-local/index"
import type { EngineEvent } from "@/types/engine"
import { describe, expect, test } from "vitest"

const enabled =
  process.env.KOBE_CODEX_APP_SERVER_REAL === "1" && spawnSync("which", ["codex"], { encoding: "utf8" }).status === 0

const d = enabled ? describe : describe.skip

d("CodexLocal — app-server real smoke", () => {
  test("spawn streams assistant text and exact app-server context telemetry", { timeout: 90_000 }, async () => {
    const engine = new CodexLocal({ backend: "app-server" })
    const handle = await engine.spawn("/tmp", "Reply with exactly the word OK and nothing else.", {
      permissionMode: "default",
    })
    const events: EngineEvent[] = []
    try {
      for await (const ev of engine.stream(handle)) {
        events.push(ev)
        if (ev.type === "done" || ev.type === "error") break
      }
    } finally {
      await engine.deleteHistory(handle.sessionId).catch(() => {})
    }

    expect(events.find((e) => e.type === "assistant.delta")?.text ?? "").toMatch(/ok/i)
    const usage = events.find((e): e is Extract<EngineEvent, { type: "usage" }> => e.type === "usage")
    expect(usage?.context_tokens).toBeGreaterThan(0)
    expect(usage?.context_window_tokens).toBeGreaterThan(0)
    expect(usage?.context_tokens_approximate).toBeUndefined()
    expect(events[events.length - 1]?.type).toBe("done")
  })
})
