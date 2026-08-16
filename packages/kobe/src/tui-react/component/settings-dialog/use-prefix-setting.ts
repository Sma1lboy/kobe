import { errorMessage } from "@/lib/error-message"
import { writePrefixKey } from "../../../state/keybindings-file"
import { reloadUserKeybindings } from "../../../tui/context/keybindings-user"
import { currentPrefixConfiguration } from "../../../tui/lib/keymap-dispatch"
import { normalizePrefixInput } from "../../../tui/lib/prefix-setting"
import { useT } from "../../i18n"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { RenameTaskDialog } from "../rename-task-dialog"

export function usePrefixSetting(dialog: DialogContext): { editPrefixKey: () => Promise<void> } {
  const t = useT()

  async function editPrefixKey(): Promise<void> {
    const current = currentPrefixConfiguration().key ?? "disabled"
    const next = await RenameTaskDialog.show(dialog, current, {
      dialogTitle: t("settings.keybindings.prefixDialogTitle"),
      fieldLabel: t("settings.keybindings.prefixDialogField"),
      submitLabel: t("common.save"),
      placeholder: t("settings.keybindings.prefixDialogPlaceholder"),
    })
    if (next === undefined) return
    const parsed = normalizePrefixInput(next)
    if ("error" in parsed) {
      await DialogConfirm.show(
        dialog,
        t("settings.keybindings.prefixInvalidTitle"),
        t("settings.keybindings.prefixInvalidBody", { error: parsed.error, current }),
        t("common.cancel"),
      )
      return
    }
    try {
      writePrefixKey(parsed.key)
      reloadUserKeybindings()
    } catch (err) {
      await DialogConfirm.show(
        dialog,
        t("settings.keybindings.prefixSaveErrorTitle"),
        errorMessage(err),
        t("common.cancel"),
      )
    }
  }

  return { editPrefixKey }
}
