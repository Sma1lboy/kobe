/**
 * Public entry point for the Ctrl+R prompt-history palette (KOB-154).
 * Mirrors the `RenameTaskDialog.show()` shape: callers await the
 * promise; it resolves with the selected entry's raw stored value
 * (`!`-prefixed for bash entries) or `undefined` on cancel.
 */

import type { DialogContext } from "../../../ui/dialog"
import { HistoryPaletteView } from "./HistoryPalette"

function show(
  dialog: DialogContext,
  opts: {
    readonly taskLabelFor: (historyKey: string) => string | undefined
    readonly currentProject: string | undefined
  },
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <HistoryPaletteView
          taskLabelFor={opts.taskLabelFor}
          currentProject={opts.currentProject}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const HistoryPalette = {
  show,
}
