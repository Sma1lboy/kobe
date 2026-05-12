/**
 * Model picker dialog — pick which Anthropic model the active task
 * should use on the next spawn/resume.
 *
 * Mirrors {@link DialogConfirm}'s static `show()` shape: returns a
 * Promise that resolves to the chosen model id (always a real id
 * post-bug-fix), or `undefined` when the user dismisses with esc.
 */

import { allModels, defaultCapabilities } from "@/engine/registry"
import { TextAttributes } from "@opentui/core"
import { For, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../../context/theme"
import { useBindings } from "../../../lib/keymap"
import { type DialogContext, useDialog } from "../../../ui/dialog"
import { modelPickerMetaLabel, modelPickerRowParts } from "./model-picker-row"

export type ModelPickerResult = string | undefined

export type ModelPickerProps = {
  current: string | undefined
  onPick: (id: string) => void
  onCancel: () => void
}

function ModelPicker(props: ModelPickerProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Memoised so adding vendors later (codex) doesn't recompute on every
  // key event. The list is stable for the dialog's lifetime.
  const choices = createMemo(() => allModels())

  // Cursor starts on the currently-pinned model so a single enter
  // re-confirms the existing choice without changing it. When unpinned,
  // seed on the active vendor's resolved default so the picker reflects
  // what the user is actually running.
  const seed = props.current ?? defaultCapabilities.defaultModelId()
  const initial = choices().findIndex((m) => m.id === seed)
  const [cursor, setCursor] = createSignal(initial >= 0 ? initial : 0)

  function commit(): void {
    const choice = choices()[cursor()]
    if (!choice) return
    props.onPick(choice.id)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "up",
        cmd: () => {
          const n = choices().length
          if (n === 0) return
          setCursor((c) => (c - 1 + n) % n)
        },
      },
      {
        key: "down",
        cmd: () => {
          const n = choices().length
          if (n === 0) return
          setCursor((c) => (c + 1) % n)
        },
      },
      {
        key: "k",
        cmd: () => {
          const n = choices().length
          if (n === 0) return
          setCursor((c) => (c - 1 + n) % n)
        },
      },
      {
        key: "j",
        cmd: () => {
          const n = choices().length
          if (n === 0) return
          setCursor((c) => (c + 1) % n)
        },
      },
      { key: "return", cmd: commit },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Pick a model
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <For each={choices()}>
          {(choice, i) => {
            const active = () => i() === cursor()
            const parts = () => modelPickerRowParts(choice)
            return (
              <box
                flexDirection="row"
                gap={2}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.primary : undefined}
                onMouseUp={() => {
                  setCursor(i())
                  commit()
                }}
              >
                <text
                  fg={active() ? theme.selectedListItemText : theme.text}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {active() ? "▸ " : "  "}
                  {modelPickerMetaLabel(parts())}
                </text>
                <text
                  fg={active() ? theme.selectedListItemText : theme.text}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {parts().model}
                </text>
                {parts().hint ? (
                  <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {parts().hint}
                  </text>
                ) : null}
              </box>
            )
          }}
        </For>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>↑↓ pick · enter select · esc cancel</text>
      </box>
    </box>
  )
}

ModelPicker.show = (dialog: DialogContext, current: string | undefined): Promise<ModelPickerResult> => {
  return new Promise<ModelPickerResult>((resolve) => {
    dialog.replace(
      () => <ModelPicker current={current} onPick={(id) => resolve(id)} onCancel={() => resolve(undefined)} />,
      () => resolve(undefined),
    )
  })
}

export { ModelPicker }
