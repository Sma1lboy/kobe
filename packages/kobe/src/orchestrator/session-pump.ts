/**
 * SessionPump — the per-(Task, ChatTab) consumer of `engine.stream()`.
 *
 * One pump runs per active ChatTab. The pump drains the engine's
 * async iterator, fans every event out to subscribers via the
 * caller-supplied `dispatch` callback, and watches for two special
 * shapes:
 *
 *   1. **Pause-tool starts** (`ExitPlanMode`, `AskUserQuestion`).
 *      `detectUserInputFromEngineEvent` classifies the `tool.start`
 *      event; the pump records the request into the
 *      {@link PendingInputBroker}, fires a synthetic
 *      `user_input.request` event, kills the engine, and stops
 *      draining. The task stays `in_progress` while the user thinks
 *      — `Orchestrator.respondToInput` is what resumes the session
 *      once the user answers.
 *   2. **Terminal `done` / `error`.** Buffered, not dispatched
 *      inline. The orchestrator wants engine cleanup + store status
 *      writes to settle before subscribers react to `done`, so the
 *      pump returns the terminal event and the orchestrator
 *      dispatches it after its own post-pump bookkeeping. See the
 *      `pumps.delete` / `store.update` block in
 *      `Orchestrator.runPumpAndCleanup`.
 *
 * Everything that touches Orchestrator-owned state (the handles
 * map, the pumps map, the task-status state machine, the run-state
 * signal) lives on the caller, not on the pump. The pump's job is
 * "drive this one session to a stopping point and tell me what
 * happened." That makes it unit-testable with a fake engine + an
 * in-memory broker + a callback that records dispatches — no
 * Orchestrator instance required.
 *
 * Naming:
 *   See `CONTEXT.md` § Language → "SessionPump." Aliases ("stream
 *   loop," "event driver," "runner") are listed in _Avoid_ and
 *   shouldn't show up in code or docs.
 */

import type { AIEngine, EngineEvent, OrchestratorEvent, SessionHandle } from "../types/engine.ts"
import type { PendingInputBroker } from "../types/pending-input-broker.ts"
import { chatRunStateKey } from "./core.ts"
import { detectUserInputFromEngineEvent } from "./user-input.ts"

export interface SessionPumpEnvironment {
  /**
   * Resolver for the engine to drive a given (Task, ChatTab). Each
   * `run()` call invokes this once with the taskId so vendor routing
   * is decided at run time, not when the pump was constructed.
   * The pump never spawns / resumes — those are the orchestrator's job.
   */
  readonly engineFor: (taskId: string, tabId: string) => AIEngine
  /** Broker the pump writes into when a pause tool fires. */
  readonly broker: PendingInputBroker
  /**
   * Dispatch a downstream event to the per-(task, tab) subscriber
   * bus. The pump uses this for every engine event except the
   * terminal one — that's returned to the caller for post-cleanup
   * dispatch.
   */
  readonly dispatch: (taskId: string, tabId: string, ev: OrchestratorEvent) => void
  /**
   * Allocate a fresh requestId for a pending-input record. The
   * orchestrator owns the counter; the pump just calls this when it
   * detects a pause. (Decoupling lets tests inject deterministic ids.)
   */
  readonly nextRequestId: () => string
  /**
   * Called after the pump mutates the broker — once on `record`. The
   * orchestrator wires this to its `bumpRunState` so the
   * "awaiting_input" dot lights up in the same render frame the
   * `user_input.request` event arrives. No-op-safe if a caller
   * doesn't care.
   */
  readonly onPendingInputChange?: () => void
}

export interface PumpRunResult {
  /**
   * The `done` / `error` event the engine yielded, if any. The
   * pump did NOT dispatch this — the orchestrator dispatches after
   * its post-pump cleanup so subscribers reacting to `done` see
   * the engine + store fully settled.
   */
  readonly terminalEvent: EngineEvent | null
  /**
   * `true` when the pump stopped because a pause tool fired. The
   * orchestrator uses this to skip terminal-status writes —
   * `killedForInput` leaves the task `in_progress` because the
   * user is about to answer and a follow-up `runTask` is incoming.
   */
  readonly killedForInput: boolean
}

export class SessionPump {
  constructor(private readonly env: SessionPumpEnvironment) {}

  /**
   * Drive one engine session to a stopping point. Resolves when the
   * stream completes, errors, or the pump kills the engine after a
   * pause tool. Engine cleanup (`engine.stop`) is invoked in the
   * `finally` either way — idempotent against natural completion
   * but defensive against the loop bailing early.
   */
  async run(taskId: string, tabId: string, handle: SessionHandle): Promise<PumpRunResult> {
    const tabKey = chatRunStateKey(taskId, tabId)
    const engine = this.env.engineFor(taskId, tabId)
    let killedForInput = false
    let terminalEvent: EngineEvent | null = null
    try {
      for await (const ev of engine.stream(handle)) {
        // Pause-tool detection piggybacks on `tool.start` so the UI
        // surfaces the approval banner without waiting for the tool's
        // file write to complete in the subprocess.
        const inputReq = detectUserInputFromEngineEvent(ev)
        if (inputReq) {
          this.env.dispatch(taskId, tabId, ev)
          const requestId = this.env.nextRequestId()
          this.env.broker.record(taskId, tabKey, requestId, inputReq)
          this.env.onPendingInputChange?.()
          this.env.dispatch(taskId, tabId, {
            type: "user_input.request",
            requestId,
            payload: inputReq,
          })
          // STOP the subprocess. In `claude -p` mode the user-input
          // tools (ExitPlanMode, AskUserQuestion) return immediately
          // with empty/default answers and the model just keeps yapping
          // past the request — the picker shows up AFTER the model's
          // "looks like you didn't answer" text. Killing here freezes
          // the conversation at the request; respondToInput resumes the
          // same session via --resume with the user's actual answer.
          killedForInput = true
          try {
            await engine.stop(handle)
          } catch {
            /* best-effort kill; the for-await still ends */
          }
          break
        }
        if (ev.type === "done" || ev.type === "error") {
          // Buffer the terminal event; caller dispatches after its
          // post-pump cleanup so subscribers reacting to `done` see
          // the orchestrator's handles map + store status fully
          // settled. Dispatching inline raced with mid-stream queue
          // / steer follow-ups — a queued runTask would re-spawn
          // before the registry had freed the just-finished sessionId.
          terminalEvent = ev
          continue
        }
        this.env.dispatch(taskId, tabId, ev)
      }
    } finally {
      // Force engine cleanup so the registry slot for this sessionId
      // is freed before any subscriber reacts to `done`. Idempotent —
      // for natural done, registry.kill short-circuits because the
      // proc already exited; the parse loop's own finally also
      // unregisters, but we can't await *that* directly so we call
      // stop() to bound the timing.
      if (!killedForInput) {
        try {
          await engine.stop(handle)
        } catch {
          /* best-effort */
        }
      }
    }
    return { terminalEvent, killedForInput }
  }
}
