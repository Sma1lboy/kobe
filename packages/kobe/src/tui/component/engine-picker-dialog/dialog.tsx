import { t } from "@/tui/i18n"
import { ALL_VENDORS, type VendorId, nextVendorWithin, prevVendorWithin } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"

export function EnginePickerDialogView(props: {
  availableVendors: readonly VendorId[]
  defaultVendor: VendorId
  dialogTitle?: string
  onSubmit: (vendor: VendorId) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const vendors = (): readonly VendorId[] => (props.availableVendors.length > 0 ? props.availableVendors : ALL_VENDORS)
  const [vendor, setVendor] = createSignal<VendorId>(
    vendors().includes(props.defaultVendor) ? props.defaultVendor : (vendors()[0] ?? "claude"),
  )

  function commit(picked: VendorId): void {
    props.onSubmit(picked)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "left", cmd: () => setVendor((v) => prevVendorWithin(vendors(), v)) },
      { key: "right", cmd: () => setVendor((v) => nextVendorWithin(vendors(), v)) },
      { key: "return", cmd: () => commit(vendor()) },
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
        <For each={vendors()}>
          {(v) => {
            const selected = () => vendor() === v
            return (
              <text
                fg={selected() ? theme.primary : theme.textMuted}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                onMouseUp={() => commit(v)}
              >
                {selected() ? "▸ " : "  "}
                {v}
              </text>
            )
          }}
        </For>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("terminal.tab.chooseEngineHint")}</text>
      </box>
    </box>
  )
}
