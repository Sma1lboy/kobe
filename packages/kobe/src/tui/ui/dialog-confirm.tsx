/**
 * Confirm dialog — yes/no prompt with focused buttons.
 *
 * Adapted from `refs/opencode/packages/opencode/src/cli/cmd/tui/ui/dialog-confirm.tsx`.
 * The `Locale.titlecase(...)` call from `@opencode-ai/core/util/locale` was
 * inlined as a local one-liner; everything else (left/right to switch focus,
 * enter to commit, esc to cancel via the dialog stack) is preserved.
 *
 * Static `DialogConfirm.show(dialog, title, message, label?)` returns a
 * Promise<boolean | undefined>; `undefined` resolves when the dialog is
 * dismissed without an answer (e.g. esc).
 */

import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
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
}

export type DialogConfirmResult = boolean | undefined

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({ active: "confirm" as "confirm" | "cancel" })

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        cmd: () => {
          if (store.active === "confirm") props.onConfirm?.()
          if (store.active === "cancel") props.onCancel?.()
          dialog.clear()
        },
      },
      {
        key: "left",
        cmd: () => setStore("active", store.active === "confirm" ? "cancel" : "confirm"),
      },
      {
        key: "right",
        cmd: () => setStore("active", store.active === "confirm" ? "cancel" : "confirm"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                if (key === "confirm") props.onConfirm?.()
                if (key === "cancel") props.onCancel?.()
                dialog.clear()
              }}
            >
              <text fg={key === store.active ? theme.selectedListItemText : theme.textMuted}>
                {titlecase(key === "cancel" ? (props.label ?? key) : key)}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

DialogConfirm.show = (
  dialog: DialogContext,
  title: string,
  message: string,
  label?: string,
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
        />
      ),
      () => resolve(undefined),
    )
  })
}
