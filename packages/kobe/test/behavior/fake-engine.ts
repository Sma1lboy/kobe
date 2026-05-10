/**
 * In-memory deterministic `AIEngine` implementation for behavior tests.
 *
 * Why this exists:
 *   - Behavior tests must NOT spawn the real `claude` CLI: it costs
 *     tokens, hits the network, and is non-deterministic.
 *   - We need a way to script "the engine emits these events in this
 *     order" so a test can assert "the chat pane shows that text".
 *   - `FakeAIEngine.script(sessionId, events)` queues events; the
 *     async iterator returned by `stream()` yields them in order.
 *
 * Design choices:
 *   - Sessions are keyed by `sessionId` (string). Unscripted streams
 *     immediately yield `{ type: "done" }` so a test that forgets to
 *     script doesn't hang forever.
 *   - `spawn()` synthesizes a stable session id (`fake-<n>`) so test
 *     assertions can be deterministic.
 *   - History is held in-memory (`historyBySession`). Tests can
 *     pre-seed it via `setHistory()`.
 *   - No timing knobs in v1 — events fire as fast as the consumer
 *     pulls. If a test needs paced delivery, add `delayMs` later.
 */

import type { AIEngine, EngineEvent, Message, SessionHandle, SpawnOpts } from "./_engine-types"

type ScriptedQueue = {
  events: EngineEvent[]
  /** Resolves when a new event arrives or the queue is closed. */
  waiters: Array<() => void>
  closed: boolean
}

export class FakeAIEngine implements AIEngine {
  private nextId = 1
  private queues = new Map<string, ScriptedQueue>()
  private historyBySession = new Map<string, Message[]>()
  private stopped = new Set<string>()

  /**
   * Pre-seed events for a session id. Subsequent calls *append* —
   * later `script()` calls extend the queue, they don't replace it.
   * If `stream(handle)` has already drained, new events are still
   * delivered (the iterator wakes on the new push).
   */
  script(sessionId: string, events: EngineEvent[]): void {
    const q = this.ensureQueue(sessionId)
    q.events.push(...events)
    this.notify(q)
  }

  /**
   * Mark a session's stream as finished. Equivalent to scripting a
   * trailing `{ type: "done" }`, but explicit. Idempotent.
   */
  finish(sessionId: string): void {
    const q = this.ensureQueue(sessionId)
    q.closed = true
    this.notify(q)
  }

  /** Pre-seed history that `readHistory()` will return. */
  setHistory(sessionId: string, messages: Message[]): void {
    this.historyBySession.set(sessionId, messages)
  }

  async spawn(cwd: string, _prompt: string, _opts?: SpawnOpts): Promise<SessionHandle> {
    const sessionId = `fake-${this.nextId++}`
    this.ensureQueue(sessionId)
    return { sessionId, cwd }
  }

  async resume(sessionId: string, _prompt: string, _opts?: SpawnOpts): Promise<SessionHandle> {
    // Mirror the real engine: `claude --resume <sid>` spawns a fresh
    // subprocess for the same session, so any prior `stop()` shouldn't
    // make a new iterator return immediately. We also reopen the queue
    // (closed after stop) so newly-scripted events flow into the new
    // pump.
    this.stopped.delete(sessionId)
    const q = this.queues.get(sessionId)
    if (q) q.closed = false
    this.ensureQueue(sessionId)
    return { sessionId, cwd: process.cwd() }
  }

  stream(handle: SessionHandle): AsyncIterable<EngineEvent> {
    const sessionId = handle.sessionId
    const q = this.ensureQueue(sessionId)
    const stopped = this.stopped

    return {
      async *[Symbol.asyncIterator]() {
        let idx = 0
        while (true) {
          if (stopped.has(sessionId)) return
          if (idx < q.events.length) {
            const ev = q.events[idx++]
            if (ev) yield ev
            if (ev?.type === "done" || ev?.type === "error") return
            continue
          }
          if (q.closed) return
          await new Promise<void>((resolve) => q.waiters.push(resolve))
        }
      },
    }
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return this.historyBySession.get(sessionId) ?? []
  }

  async deleteHistory(sessionId: string): Promise<void> {
    this.historyBySession.delete(sessionId)
  }

  async stop(handle: SessionHandle): Promise<void> {
    this.stopped.add(handle.sessionId)
    const q = this.queues.get(handle.sessionId)
    if (q) {
      q.closed = true
      this.notify(q)
    }
  }

  /** Test-only: drop all scripted state. */
  reset(): void {
    for (const q of this.queues.values()) {
      q.closed = true
      this.notify(q)
    }
    this.queues.clear()
    this.historyBySession.clear()
    this.stopped.clear()
    this.nextId = 1
  }

  private ensureQueue(sessionId: string): ScriptedQueue {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { events: [], waiters: [], closed: false }
      this.queues.set(sessionId, q)
    }
    return q
  }

  private notify(q: ScriptedQueue): void {
    const waiters = q.waiters
    q.waiters = []
    for (const w of waiters) w()
  }
}
