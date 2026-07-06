/**
 * Engine-picker dialog entry point.
 *
 * Public API mirrors the other dialogs in `tui/component/`:
 *
 *   const vendor = await EnginePickerDialog.show(dialog, available, current)
 *   if (vendor === undefined) return  // user pressed esc
 *   // ...open the tab with `vendor`
 */

import type { VendorId } from "@/types/vendor"
import type { DialogContext } from "../../ui/dialog"
import { EnginePickerDialogView } from "./dialog"

function show(
  dialog: DialogContext,
  availableVendors: readonly VendorId[],
  defaultVendor: VendorId,
  opts: { dialogTitle?: string } = {},
): Promise<VendorId | undefined> {
  return new Promise<VendorId | undefined>((resolve) => {
    dialog.replace(
      () => (
        <EnginePickerDialogView
          availableVendors={availableVendors}
          defaultVendor={defaultVendor}
          dialogTitle={opts.dialogTitle}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const EnginePickerDialog = {
  show,
}
