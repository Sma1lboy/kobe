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

/**
 * Open the new-task dialog and resolve with the user's selection.
 * Resolves with `undefined` when the user cancels (esc / dialog
 * dismissed). Matches the existing dialog-stack convention used by
 * `SettingsDialog.show`, `HelpDialog.show`, etc.
 */
function show(
  dialog: DialogContext,
  defaultRepo: string,
  savedRepos: readonly string[],
): Promise<NewTaskInput | undefined> {
  return new Promise<NewTaskInput | undefined>((resolve) => {
    dialog.replace(
      () => (
        <NewTaskDialogView
          defaultRepo={defaultRepo}
          savedRepos={savedRepos}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
    // New-task uses medium (80 cols). small (50) clipped repo paths
    // mid-row; medium gives full `/Users/jacksonc/...` strings room
    // to breathe. The card now sizes to content height — earlier
    // medium looked oversized because of a wrapper scrollbox that
    // stretched the card vertically; that's fixed.
    dialog.setSize("medium")
  })
}

export const NewTaskDialog = {
  show,
}
