/**
 * Rename-task dialog entry point.
 *
 * Public API mirrors the other dialogs in this folder:
 *
 *   const next = await RenameTaskDialog.show(dialog, currentTitle)
 *   if (next === undefined) return  // user pressed esc
 *   // ...orchestrator.setTitle(taskId, next)
 *
 * The `opts.dialogTitle` override lets the same dialog double as a
 * chat-tab rename ("Rename chat tab") without forking the UI.
 */

import type { DialogContext } from "../../ui/dialog"
import { RenameTaskDialogView } from "./dialog"

/**
 * Open the rename dialog and resolve with the new title (trimmed). The
 * promise resolves with `undefined` when the user cancels (esc /
 * dialog dismissed), matching the convention used by other dialogs.
 */
function show(
  dialog: DialogContext,
  currentTitle: string,
  opts: { dialogTitle?: string } = {},
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialogView
          currentTitle={currentTitle}
          dialogTitle={opts.dialogTitle}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const RenameTaskDialog = {
  show,
}
