/**
 * Quick-fork dialog entry point.
 *
 * Public API:
 *
 *   const result = await QuickForkDialog.show(dialog, {
 *     repo, baseRef, modelId, effort,
 *   })
 *   if (!result) return  // user pressed esc
 *   // result = { prompt, modelId, effort } — modelId / effort may differ
 *   //   from the input if the user picked a different one in the dialog
 *
 * The caller seeds the inherited repo/branch/model/effort; the dialog
 * lets the user override the model + effort before submitting the
 * first prompt.
 */

import type { ModelEffortLevel } from "@/types/engine"
import type { DialogContext } from "../../ui/dialog"
import { QuickForkDialogView, type QuickForkSubmit } from "./dialog"

export type QuickForkInput = {
  repo: string
  baseRef: string
  modelId: string | undefined
  effort: ModelEffortLevel | undefined
}

export type QuickForkResult = QuickForkSubmit

function show(dialog: DialogContext, input: QuickForkInput): Promise<QuickForkResult | undefined> {
  return new Promise<QuickForkResult | undefined>((resolve) => {
    dialog.replace(
      () => (
        <QuickForkDialogView
          repo={input.repo}
          baseRef={input.baseRef}
          modelId={input.modelId}
          effort={input.effort}
          onSubmit={(result) => resolve(result)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
    // Larger dialog than the original prompt-only card — model list
    // takes 7-8 rows, effort up to 5, plus summary + prompt + footer.
    // `large` gives enough vertical room without becoming a fullscreen
    // takeover on tall terminals.
    dialog.setSize("large")
  })
}

export const QuickForkDialog = {
  show,
}
