/**
 * Test-only globals mounted on `globalThis` for the behavior harness.
 *
 * The fake-engine HTTP server (started in `startApp` when
 * `KOBE_TEST_FAKE_PORT` is set) needs to trigger user verbs (`requestPR`,
 * `respondToInput`) for whatever task is currently active. The Shell is
 * the only owner of an active-task accessor, so it mounts two globals:
 *
 *   - `__kobeTestRequestPR()` — render the PR-instructions prompt
 *     against the active task's worktree, then call
 *     `orchestrator.requestPR`.
 *   - `__kobeTestRespondToInput(response)` — picks the latest pending
 *     request on the active task and dispatches the user's
 *     ApprovePlanResponse / AskQuestionResponse synthetically.
 *
 * The HTTP server (in `./engine-bootstrap.ts`) reads these globals at
 * request time, so this hook only mounts; it never tears down (kobe
 * exits cleanly).
 *
 * Production never sets `KOBE_TEST_FAKE_PORT`, so these globals are
 * harmless dead branches when the harness isn't driving.
 */

import type { Accessor } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"

export function useTestSideChannel(deps: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
}): void {
  const { orchestrator, activeTask } = deps
  if (typeof globalThis === "undefined") return

  // Side-channel PR trigger for the W4.PR behavior test. When
  // KOBE_TEST_FAKE_PORT is active, the fake-engine HTTP server also
  // exposes POST /pr which calls requestPR for the active task. The
  // test uses this in preference to keystroke-driven invocation because
  // key dispatch interacts with the focused composer's keymap in ways
  // the test shouldn't have to debug.
  ;(globalThis as { __kobeTestRequestPR?: () => Promise<{ taskId: string; prompt: string }> }).__kobeTestRequestPR =
    async () => {
      const task = activeTask()
      if (!task || !task.worktreePath || task.status === "canceled") {
        throw new Error("no usable active task for PR (no worktree, no task, or canceled)")
      }
      // Render the prompt OUTSIDE of requestPR so the test can assert
      // on what was actually sent. This duplicates a tiny bit of logic
      // for the test affordance only — production goes through
      // requestPR which independently renders + sends.
      const { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } = await import(
        "../../orchestrator/pr/index.ts"
      )
      const state = await gatherPRState(task.worktreePath)
      const template = await loadPRInstructionsTemplate(task.worktreePath)
      const rendered = renderPRInstructions(template, state)
      await orchestrator.requestPR(task.id)
      return { taskId: task.id, prompt: rendered }
    }

  // Side-channel respond trigger for the user-input pause behavior
  // tests (ExitPlanMode + AskUserQuestion). The chat row's
  // mouse-click path through onApprove/onAnswer eventually calls
  // orchestrator.respondToInput, but driving that from a PTY test
  // requires SGR mouse delivery the screen-capture path doesn't
  // honor. We expose a server-side hook that picks the latest
  // pending requestId for the active task and dispatches the
  // user's response synthetically. The render side (status flip on
  // the picker, composer unlock, synthetic user.inject row) is the
  // same code path real clicks would exercise — only the
  // input-event delivery differs.
  type RespondTrigger = (
    response: import("../../types/engine.ts").UserInputResponse,
  ) => Promise<{ taskId: string; requestId: string; prompt: string }>
  ;(globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput = async (response) => {
    const task = activeTask()
    if (!task) throw new Error("no active task for respondToInput")
    const pending = orchestrator.peekPendingInput(task.id)
    if (pending.length === 0) {
      throw new Error("no pending input for active task — picker hasn't rendered yet?")
    }
    // Latest request wins. Multiple pending requests on one task is
    // not currently a real flow (the orchestrator kills the
    // subprocess on the first user-input tool start), but if it
    // becomes one the test can extend the seam with an explicit
    // requestId selector.
    const latest = pending[pending.length - 1]
    if (!latest) throw new Error("no pending input for active task — picker hasn't rendered yet?")
    const { renderUserInputResponsePrompt } = await import("../../orchestrator/core.ts")
    const prompt = renderUserInputResponsePrompt(latest.payload, response)
    await orchestrator.respondToInput(task.id, latest.requestId, response)
    return { taskId: task.id, requestId: latest.requestId, prompt }
  }
}
