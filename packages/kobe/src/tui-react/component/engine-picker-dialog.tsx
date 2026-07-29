/** @jsxImportSource @opentui/react */
/**
 * Engine-picker dialog (React port of `tui/component/engine-picker-dialog/`,
 * issue #16 React migration) — the `chat.tab.chooseEngine` (ctrl+e) flow's
 * pure-tui prompt: left/right cycles the highlighted choice (mirrors the
 * new-task dialog's own engine selector), enter confirms, esc cancels.
 * With `allowShell` the vendor row gains a trailing "shell" entry — a plain
 * terminal tab is a first-class tab type, not only the engine-exit degrade
 * path. View + `show` entry in one file, same folder-collapse convention as
 * the React `rename-task-dialog.tsx`.
 */

import { ALL_VENDORS, type VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"
import { ChoiceRow } from "./new-task-dialog/picker-list"

/** What the picker can resolve to: an engine vendor or a plain shell tab.
 *  With `extraChoices`, an extra choice's `key` (e.g. a plugin pane) too. */
export type EnginePick = VendorId | "shell" | (string & {})

export function EnginePickerDialogView(props: {
  availableVendors: readonly VendorId[]
  defaultVendor: VendorId
  dialogTitle?: string
  /** Offer a trailing "shell" choice (a plain terminal tab). */
  allowShell?: boolean
  /** Trailing extra choices (plugin panes): `key` is returned, `label` shown. */
  extraChoices?: readonly { key: string; label: string }[]
  onSubmit: (pick: EnginePick) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const vendors = props.availableVendors.length > 0 ? props.availableVendors : ALL_VENDORS
  const extras = props.extraChoices ?? []
  const choices: readonly EnginePick[] = [
    ...vendors,
    ...(props.allowShell ? (["shell"] as const) : []),
    ...extras.map((e) => e.key),
  ]
  const [pick, setPick] = useState<EnginePick>(
    vendors.includes(props.defaultVendor) ? props.defaultVendor : (choices[0] ?? "claude"),
  )
  const display = (choice: EnginePick): string => extras.find((e) => e.key === choice)?.label ?? choice

  function commit(picked: EnginePick): void {
    props.onSubmit(picked)
    dialog.clear()
  }

  const cycle = (dir: 1 | -1) =>
    setPick((cur) => {
      const i = choices.indexOf(cur)
      return choices[(i + dir + choices.length) % choices.length] ?? cur
    })

  useBindings(() => ({
    bindings: [
      { key: "left", cmd: () => cycle(-1) },
      { key: "right", cmd: () => cycle(1) },
      { key: "h", cmd: () => cycle(-1) },
      { key: "l", cmd: () => cycle(1) },
      { key: "return", cmd: () => commit(pick) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.dialogTitle ?? t("terminal.tab.chooseEngineTitle")}
        </text>
        <text
          fg={theme.textMuted}
          onMouseUp={() => {
            // Cancel must also CLOSE — resolving the promise alone left the
            // card on screen with its onClose already spent.
            props.onCancel()
            dialog.clear()
          }}
        >
          esc
        </text>
      </box>
      <ChoiceRow choices={choices} selected={pick} display={display} onPick={(v) => commit(v)} />
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
  opts: { dialogTitle?: string; allowShell?: boolean; extraChoices?: readonly { key: string; label: string }[] } = {},
): Promise<EnginePick | undefined> {
  return showDialog<EnginePick>(dialog, (resolve) => (
    <EnginePickerDialogView
      availableVendors={availableVendors}
      defaultVendor={defaultVendor}
      dialogTitle={opts.dialogTitle}
      allowShell={opts.allowShell}
      extraChoices={opts.extraChoices}
      onSubmit={(v) => resolve(v)}
      onCancel={() => resolve(undefined)}
    />
  ))
}

export const EnginePickerDialog = {
  show,
}
