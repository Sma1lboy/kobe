/**
 * Model picker dialog — pick which Anthropic model the active task
 * should use on the next spawn/resume.
 *
 * Mirrors {@link DialogConfirm}'s static `show()` shape: returns a
 * Promise that resolves to the chosen model id (or `undefined` when
 * the user dismisses with esc). `null` means "the user explicitly
 * picked the default — clear the pinned model"; the caller distinguishes
 * those two outcomes when writing back.
 */

import { TextAttributes } from "@opentui/core"
import { For, createSignal } from "solid-js"
import { useTheme } from "../../../context/theme"
import { useBindings } from "../../../lib/keymap"
import { type DialogContext, useDialog } from "../../../ui/dialog"
import { MODEL_CHOICES } from "./models"

export type ModelPickerResult = string | null | undefined

export type ModelPickerProps = {
  current: string | undefined
  onPick: (id: string | undefined) => void
  onCancel: () => void
}

function ModelPicker(props: ModelPickerProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Cursor starts on the currently-pinned model so a single enter
  // re-confirms the existing choice without changing it.
  const initial = MODEL_CHOICES.findIndex((m) => m.id === props.current)
  const [cursor, setCursor] = createSignal(initial >= 0 ? initial : 0)

  function commit(): void {
    const choice = MODEL_CHOICES[cursor()]
    if (!choice) return
    props.onPick(choice.id)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => setCursor((c) => (c - 1 + MODEL_CHOICES.length) % MODEL_CHOICES.length) },
      { key: "down", cmd: () => setCursor((c) => (c + 1) % MODEL_CHOICES.length) },
      { key: "k", cmd: () => setCursor((c) => (c - 1 + MODEL_CHOICES.length) % MODEL_CHOICES.length) },
      { key: "j", cmd: () => setCursor((c) => (c + 1) % MODEL_CHOICES.length) },
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
        <For each={MODEL_CHOICES}>
          {(choice, i) => {
            const active = () => i() === cursor()
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
                  {choice.label}
                </text>
                {choice.hint ? (
                  <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {choice.hint}
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
      () => <ModelPicker current={current} onPick={(id) => resolve(id ?? null)} onCancel={() => resolve(undefined)} />,
      () => resolve(undefined),
    )
  })
}

export { ModelPicker }
