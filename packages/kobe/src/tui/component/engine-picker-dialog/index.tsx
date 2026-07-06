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
