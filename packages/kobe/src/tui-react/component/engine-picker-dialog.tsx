/** @jsxImportSource @opentui/react */
/**
 * Engine-picker dialog (React port of `tui/component/engine-picker-dialog/`,
 * issue #16 React migration) — the `chat.tab.chooseEngine` (ctrl+e) flow's
 * pure-tui prompt: left/right cycles the highlighted vendor (mirrors the
 * new-task dialog's own engine selector), enter confirms, esc cancels.
 * View + `show` entry in one file, same folder-collapse convention as the
 * React `rename-task-dialog.tsx`.
 */

import { ALL_VENDORS, type VendorId, nextVendorWithin, prevVendorWithin } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

export function EnginePickerDialogView(props: {
  availableVendors: readonly VendorId[]
  defaultVendor: VendorId
  dialogTitle?: string
  onSubmit: (vendor: VendorId) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const vendors = props.availableVendors.length > 0 ? props.availableVendors : ALL_VENDORS
  const [vendor, setVendor] = useState<VendorId>(
    vendors.includes(props.defaultVendor) ? props.defaultVendor : (vendors[0] ?? "claude"),
  )

  function commit(picked: VendorId): void {
    props.onSubmit(picked)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "left", cmd: () => setVendor((v) => prevVendorWithin(vendors, v)) },
      { key: "right", cmd: () => setVendor((v) => nextVendorWithin(vendors, v)) },
      { key: "return", cmd: () => commit(vendor) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.dialogTitle ?? t("terminal.tab.chooseEngineTitle")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        {vendors.map((v) => {
          const selected = vendor === v
          return (
            <text
              key={v}
              fg={selected ? theme.primary : theme.textMuted}
              attributes={selected ? TextAttributes.BOLD : undefined}
              onMouseUp={() => commit(v)}
            >
              {selected ? "▸ " : "  "}
              {v}
            </text>
          )
        })}
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("terminal.tab.chooseEngineHint")}</text>
      </box>
    </box>
  )
}

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
