/**
 * Unit-level tests for `CodexLocal.resume()` failure handling.
 *
 * Uses a fake `codex` binary (a tiny shell script under a tempdir) so
 * we can exercise the spawn/exit lifecycle without the real CLI:
 *
 *   - bad-sid resume: codex exits non-zero before emitting anything →
 *     the stream must surface an `error` event (not silently close).
 *   - sid mismatch: codex emits a *different* thread id than the one
 *     we sync-bound with → the stream must surface an `error` event so
 *     the user sees the divergence.
 *
 * These regressions were both possible because resume() sync-binds with
 * the caller-supplied sessionId; without explicit propagation the
 * caller would get a resolved handle pointing at a dead/wrong session.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CodexLocal } from "@/engine/codex-local/index"
import type { EngineEvent } from "@/types/engine"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SID_REQUESTED = "00000000-0000-4000-8000-000000000001"
const SID_EMITTED = "00000000-0000-4000-8000-000000000002"

let tempBinDir: string

beforeEach(() => {
  tempBinDir = mkdtempSync(path.join(tmpdir(), "kobe-codex-fake-"))
})

afterEach(() => {
  rmSync(tempBinDir, { recursive: true, force: true })
})

describe("CodexLocal.resume — failure surfacing", () => {
  it("surfaces an error event when codex exits non-zero shortly after resume", async () => {
    const binary = writeFakeBinary(`#!/usr/bin/env bash
echo "session not found: ${SID_REQUESTED}" 1>&2
exit 2
`)
    const engine = new CodexLocal({ binaryPathResolver: async () => binary, backend: "exec" })
    const handle = await engine.resume(SID_REQUESTED, "hello", { cwd: "/tmp", permissionMode: "default" })
    expect(handle.sessionId).toBe(SID_REQUESTED)

    const events = await drainStream(engine, handle, 2_000)
    const errors = events.filter((e) => e.type === "error")
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message ?? "").toMatch(/code=2/)
    expect(errors[0]?.message ?? "").toMatch(/session not found/)
  })

  it("surfaces an error event when codex emits a different thread id on resume", async () => {
    const binary = writeFakeBinary(`#!/usr/bin/env bash
printf '%s\\n' '{"type":"thread.started","thread_id":"${SID_EMITTED}"}'
sleep 0.05
exit 0
`)
    const engine = new CodexLocal({ binaryPathResolver: async () => binary, backend: "exec" })
    const handle = await engine.resume(SID_REQUESTED, "hello", { cwd: "/tmp", permissionMode: "default" })
    expect(handle.sessionId).toBe(SID_REQUESTED)

    const events = await drainStream(engine, handle, 2_000)
    const mismatch = events.find(
      (e) => e.type === "error" && /different session id/i.test(e.message ?? "") && e.message?.includes(SID_EMITTED),
    )
    expect(mismatch, `expected sid-mismatch error event, got ${JSON.stringify(events)}`).toBeDefined()
  })
})

function writeFakeBinary(script: string): string {
  const file = path.join(tempBinDir, "codex")
  writeFileSync(file, script, "utf8")
  chmodSync(file, 0o755)
  return file
}

async function drainStream(
  engine: CodexLocal,
  handle: { sessionId: string; cwd: string },
  timeoutMs: number,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  const iter = engine.stream(handle)[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const next = iter.next()
    const winner = await Promise.race([next, sleep(timeoutMs)])
    if (!winner || (winner as IteratorResult<EngineEvent>).done) break
    const ev = (winner as IteratorResult<EngineEvent>).value
    events.push(ev)
    if (ev.type === "done" || ev.type === "error") {
      // Drain any further immediately-available events (sid mismatch may
      // arrive after the error).
      const flushDeadline = Date.now() + 100
      while (Date.now() < flushDeadline) {
        const more = await Promise.race([iter.next(), sleep(50)])
        if (!more || (more as IteratorResult<EngineEvent>).done) break
        events.push((more as IteratorResult<EngineEvent>).value)
      }
      break
    }
  }
  return events
}

function sleep(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms))
}
