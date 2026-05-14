/**
 * New-task dialog entry point.
 *
 * Public API mirrors `SettingsDialog.show(...)` and friends:
 *
 *   const result = await NewTaskDialog.show(dialog, defaultRepo, savedRepos)
 *   if (!result) return  // user pressed esc
 *   // ...createTask(result.repo, result.baseRef)
 *
 * Implementation is split for testability:
 *   - `./state.ts` — pure helpers (field cycling, repo dedup, filter,
 *     window, validate, branches). Unit-tested in
 *     `test/tui/new-task-dialog/state.test.ts`.
 *   - `./dialog.tsx` — the Solid JSX shell that wires the state
 *     helpers to signals.
 */

import type { DialogContext } from "../../ui/dialog"
import { NewTaskDialogView } from "./dialog"
import type { NewTaskInput } from "./state"

export type { NewTaskInput } from "./state"
export { stripNewlines } from "./state"

export type NewTaskDialogOptions = {
  /**
   * Default parent directory for the Clone tab — caller persists this
   * via kv `lastClonedRepoParent`. Optional; falls back to `~/` in the
   * dialog when omitted or empty.
   */
  defaultCloneParent?: string
}

/**
 * Open the new-task dialog and resolve with the user's selection.
 * Resolves with `undefined` when the user cancels (esc / dialog
 * dismissed). Matches the existing dialog-stack convention used by
 * `SettingsDialog.show`, `HelpDialog.show`, etc.
 *
 * The returned `NewTaskInput` carries an optional `cloned` field when
 * the user came in via the "For New Repo" tab — the clone has already
 * completed and `repo` is the fresh worktree path. Callers should
 * persist `cloned.parentDir` to `lastClonedRepoParent` and add `repo`
 * to the saved-repos list in that case.
 */
function show(
  dialog: DialogContext,
  defaultRepo: string,
  savedRepos: readonly string[],
  options?: NewTaskDialogOptions,
): Promise<NewTaskInput | undefined> {
  return new Promise<NewTaskInput | undefined>((resolve) => {
    dialog.replace(
      () => (
        <NewTaskDialogView
          defaultRepo={defaultRepo}
          savedRepos={savedRepos}
          defaultCloneParent={options?.defaultCloneParent}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
    // New-task uses medium (80 cols). small (50) clipped repo paths
    // mid-row; medium gives full `/Users/jacksonc/...` strings room
    // to breathe. The card sizes to content height.
    dialog.setSize("medium")
  })
}

export const NewTaskDialog = {
  show,
}
