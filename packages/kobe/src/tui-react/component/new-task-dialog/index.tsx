/** @jsxImportSource @opentui/react */
/**
 * React new-task dialog entry point (issue #15, G3W2) — the
 * `src/tui/component/new-task-dialog/index.tsx` counterpart, with the
 * identical `show(dialog, defaultRepo, savedRepos, options)` contract so
 * call sites port unchanged. NewTaskDialog is THE canonical task-creation
 * surface — this is the full dialog (Existing / New Repo / Adopt tabs,
 * engine selector, smart pickers), never a simplified stand-in.
 *
 * Pure helpers (`state.ts`) and clone plumbing (`clone.ts`) are consumed
 * from the shared Solid-side modules — both are framework-free .ts.
 */

import type { NewTaskDialogOptions, NewTaskInput } from "../../../tui/component/new-task-dialog/state"
import { type DialogContext, showDialog } from "../../ui/dialog"
import { NewTaskDialogView } from "./dialog"

export type { NewTaskDialogOptions, NewTaskInput } from "../../../tui/component/new-task-dialog/state"
export { isBlankText, stripNewlines } from "../../../tui/component/new-task-dialog/state"

/**
 * Open the new-task dialog and resolve with the user's selection —
 * `undefined` on cancel (esc / dialog dismissed). A `cloned` field on the
 * result means the user came in via the "For New Repo" tab: the clone has
 * already completed and `repo` is the fresh worktree path; persist
 * `cloned.parentDir` to `lastClonedRepoParent` and add `repo` to the
 * saved-repos list.
 */
function show(
  dialog: DialogContext,
  defaultRepo: string,
  savedRepos: readonly string[],
  options?: NewTaskDialogOptions,
): Promise<NewTaskInput | undefined> {
  // medium (80 cols) — small clipped repo paths mid-row; the card sizes
  // to content height. Same rationale as the Solid entry.
  return showDialog<NewTaskInput>(
    dialog,
    (resolve) => (
      <NewTaskDialogView
        defaultRepo={defaultRepo}
        savedRepos={savedRepos}
        defaultCloneParent={options?.defaultCloneParent}
        defaultVendor={options?.defaultVendor}
        availableVendors={options?.availableVendors}
        discoverAdoptable={options?.discoverAdoptable}
        onSubmit={(v) => resolve(v)}
        onCancel={() => resolve(undefined)}
      />
    ),
    { size: "medium" },
  )
}

export const NewTaskDialog = {
  show,
}
