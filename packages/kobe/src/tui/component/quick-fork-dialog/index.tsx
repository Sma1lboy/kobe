/**
 * Quick-fork dialog entry point.
 *
 * Public API mirrors the other dialogs in this folder:
 *
 *   const prompt = await QuickForkDialog.show(dialog, { repo, baseRef, modelLabel })
 *   if (prompt === undefined) return  // user pressed esc
 *   // ...orchestrator.createTask + runTask
 *
 * Defined as a thin promise wrapper around `dialog.replace` so the
 * caller can await the user's input alongside the rest of the
 * quick-fork action flow (use-task-actions.ts → quickForkActiveTask).
 */

import type { DialogContext } from "../../ui/dialog"
import { QuickForkDialogView } from "./dialog"

export type QuickForkInput = {
  repo: string
  baseRef: string
  modelLabel: string
}

function show(dialog: DialogContext, input: QuickForkInput): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <QuickForkDialogView
          repo={input.repo}
          baseRef={input.baseRef}
          modelLabel={input.modelLabel}
          onSubmit={(prompt) => resolve(prompt)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
    // medium (80 cols) matches NewTaskDialog so the inherited repo path
    // has room to breathe on wide terminals. The card sizes to content
    // height so the dialog stays compact for the short field list.
    dialog.setSize("medium")
  })
}

export const QuickForkDialog = {
  show,
}
