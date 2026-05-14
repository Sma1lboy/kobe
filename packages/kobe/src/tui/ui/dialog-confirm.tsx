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
  /** Custom label for the cancel button (default: `cancel`). Titlecased on render. */
  label?: string
  /** Custom label for the confirm button (default: `confirm`). Titlecased on render. */
  confirmLabel?: string
  /** Which button receives initial keyboard focus (default: `confirm`). */
  initialActive?: "confirm" | "cancel"
}

export type DialogConfirmResult = boolean | undefined
export type DialogConfirmOptions = {
  initialActive?: "confirm" | "cancel"
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({ active: props.initialActive ?? ("confirm" as "confirm" | "cancel") })

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

  // Tight vertical layout — confirms used to have a paragraph-of-air
  // around the title/message/buttons (gap=1 + bottom paddings), which
  // made a six-word prompt take 7 vertical lines. Now: title row,
  // message right under it, buttons row right under that. The dialog
  // wrapper still adds a 1-row paddingTop above the card body.
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
                {titlecase(key === "cancel" ? (props.label ?? key) : (props.confirmLabel ?? key))}
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
    // Confirms are tight yes/no prompts; the default 80-col card is
    // grossly oversized for them. Switch to the narrow `small` width
    // so the dialog reads at a glance instead of swallowing half the
    // viewport with empty space.
    dialog.setSize("small")
  })
}
