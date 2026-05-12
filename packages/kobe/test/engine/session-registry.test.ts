import { EventEmitter } from "node:events"
import { type ProcessHandle, SessionRegistry } from "@/engine/claude-code-local/registry"
import { describe, expect, it } from "vitest"

describe("SessionRegistry", () => {
  it("does not let an old process unregister a newer process with the same session id", () => {
    const registry = new SessionRegistry()
    const oldProc = fakeProc()
    const newProc = fakeProc()
    const sessionId = "sid-1"

    registry.register(handle(sessionId, oldProc, "old"))
    registry.unregister(sessionId, oldProc)
    registry.register(handle(sessionId, newProc, "new"))

    registry.unregister(sessionId, oldProc)

    expect(registry.get(sessionId)?.proc).toBe(newProc)
  })
})

function handle(sessionId: string, proc: ProcessHandle["proc"], prompt: string): ProcessHandle {
  return {
    sessionId,
    cwd: "/tmp",
    proc,
    startedAt: Date.now(),
    prompt,
  }
}

function fakeProc(): ProcessHandle["proc"] {
  const proc = new EventEmitter() as ProcessHandle["proc"]
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  })
  return proc
}
