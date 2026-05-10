/**
 * Barrel for the PR-creation submodule (Wave 4 stream W4.PR).
 *
 * The orchestrator's `requestPR(taskId)` entry point lives in
 * `../core.ts`. Everything here is the bits it composes:
 *
 *   - {@link gatherPRState} — read-only git inspection of a worktree.
 *   - {@link renderPRInstructions} / {@link loadPRInstructionsTemplate} —
 *     template rendering + per-repo override discovery.
 *   - {@link DEFAULT_PR_INSTRUCTIONS_TEMPLATE} — the canonical prompt.
 *
 * Re-exports {@link PRState} so consumers can type the state value
 * without reaching into `instructions.ts` directly.
 */

export { gatherPRState } from "./build.ts"
export {
  DEFAULT_PR_INSTRUCTIONS_TEMPLATE,
  loadPRInstructionsTemplate,
  renderPRInstructions,
} from "./instructions.ts"
export type { PRState } from "./instructions.ts"
