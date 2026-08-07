import { describe, expect, it, vi } from "vitest"
import { observeCodexSessionActivation, parseCodexResumeLog } from "../../src/engine/codex-local/session-activation.ts"

const SESSION_ID = "019fca97-e324-7351-9bcf-cd0608fd5d80"
const TRANSCRIPT = `/Users/test/.codex/sessions/2026/08/04/rollout-2026-08-04T10-26-19-${SESSION_ID}.jsonl`

describe("Codex session activation observer", () => {
  it("normalizes the exact resume log record", () => {
    expect(
      parseCodexResumeLog({
        id: 7,
        ts: 1_786_022_485,
        ts_nanos: 925_327_000,
        feedback_log_body: `Resuming rollout from "${TRANSCRIPT}"`,
      }),
    ).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: TRANSCRIPT,
      source: "resume",
      observedAt: 1_786_022_485_925,
    })
  })

  it("normalizes the selected thread id from a resume span when no rollout record exists", () => {
    expect(
      parseCodexResumeLog({
        id: 8,
        ts: 1_786_081_735,
        ts_nanos: 42_000_000,
        feedback_log_body: `app_server.request{otel.kind="server" otel.name="thread/resume"}:resume_thread_with_history:thread_spawn{otel.name="thread_spawn"}:session_init:startup_prewarm{thread.id=${SESSION_ID}}: response started`,
      }),
    ).toEqual({
      sessionId: SESSION_ID,
      source: "resume",
      observedAt: 1_786_081_735_042,
    })
  })

  it("does not infer a thread id from transcript text outside the resume span", () => {
    expect(
      parseCodexResumeLog({
        id: 9,
        ts: 1_786_081_736,
        ts_nanos: 0,
        feedback_log_body: `The log mentioned otel.name="thread/resume" and thread.id=${SESSION_ID}`,
      }),
    ).toBeNull()
  })

  it("uses the actual Codex descendant PID and forwards the EngineRun timestamp cursor", async () => {
    const latestResume = vi.fn(() => ({
      id: 8,
      ts: 1_786_022_486,
      ts_nanos: 1_000_000,
      feedback_log_body: `Resuming rollout from "${TRANSCRIPT}"`,
    }))
    await expect(
      observeCodexSessionActivation(
        { rootPid: 400, afterMs: 1_786_022_480_000 },
        {
          findEnginePid: async () => ({ vendor: "codex", pid: 401 }),
          latestResume,
        },
      ),
    ).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(latestResume).toHaveBeenCalledWith(401, 1_786_022_480_000)
  })

  it("does not inspect another engine's process", async () => {
    const latestResume = vi.fn()
    await expect(
      observeCodexSessionActivation(
        { rootPid: 400, afterMs: 0 },
        {
          findEnginePid: async () => ({ vendor: "claude", pid: 401 }),
          latestResume,
        },
      ),
    ).resolves.toBeNull()
    expect(latestResume).not.toHaveBeenCalled()
  })
})
