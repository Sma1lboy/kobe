/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "./dialog"

function titlecase(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
  confirmLabel?: string
  initialActive?: "confirm" | "cancel"
}

export type DialogConfirmResult = boolean | undefined
export type DialogConfirmOptions = {
  initialActive?: "confirm" | "cancel"
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const [active, setActive] = useState<"confirm" | "cancel">(props.initialActive ?? "confirm")

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        cmd: () => {
          if (active === "confirm") props.onConfirm?.()
          if (active === "cancel") props.onCancel?.()
          dialog.clear()
        },
      },
      { key: "left", cmd: () => setActive((a) => (a === "confirm" ? "cancel" : "confirm")) },
      { key: "right", cmd: () => setActive((a) => (a === "confirm" ? "cancel" : "confirm")) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>{props.message}</text>
      <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
        {(["cancel", "confirm"] as const).map((key) => (
          <box
            key={key}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={key === active ? theme.primary : undefined}
            onMouseUp={() => {
              if (key === "confirm") props.onConfirm?.()
              if (key === "cancel") props.onCancel?.()
              dialog.clear()
            }}
          >
            <text fg={key === active ? theme.selectedListItemText : theme.textMuted}>
              {titlecase(
                key === "cancel" ? (props.label ?? t("common.cancel")) : (props.confirmLabel ?? t("common.confirm")),
              )}
            </text>
          </box>
        ))}
      </box>
    </box>
  )
}

DialogConfirm.show = (
  dialog: DialogContext,
  title: string,
  message: string,
  label?: string,
  confirmLabel?: string,
  options?: DialogConfirmOptions,
): Promise<DialogConfirmResult> => {
  return new Promise<DialogConfirmResult>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
          label={label}
          confirmLabel={confirmLabel}
          initialActive={options?.initialActive}
        />
      ),
      () => resolve(undefined),
    )
    dialog.setSize("small")
  })
}
