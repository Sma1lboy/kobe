import type { DialogContext } from "../../ui/dialog"
import { RenameTaskDialogView } from "./dialog"

function show(
  dialog: DialogContext,
  currentTitle: string,
  opts: {
    dialogTitle?: string
    fieldLabel?: string
    submitLabel?: string
    placeholder?: string
    allowEmpty?: boolean
  } = {},
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialogView
          currentTitle={currentTitle}
          dialogTitle={opts.dialogTitle}
          fieldLabel={opts.fieldLabel}
          submitLabel={opts.submitLabel}
          placeholder={opts.placeholder}
          allowEmpty={opts.allowEmpty}
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
