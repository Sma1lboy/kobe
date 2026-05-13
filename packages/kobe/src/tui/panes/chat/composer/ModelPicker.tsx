/**
 * Model picker dialog — pick which engine model and optional effort
 * level the active chat tab should use on the next spawn/resume.
 *
 * Mirrors {@link DialogConfirm}'s static `show()` shape: returns a
 * Promise that resolves to the chosen model id + effort, or `undefined`
 * when the user dismisses with esc.
 */

import { allModels, defaultCapabilities } from "@/engine/registry"
import type { ModelChoice } from "@/types/engine"
import { TextAttributes } from "@opentui/core"
import { For, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../../context/theme"
import { useBindings } from "../../../lib/keymap"
import { type DialogContext, useDialog } from "../../../ui/dialog"
import { type ModelPickerModelOption, modelPickerEffortOptions, modelPickerModelOptions } from "./model-picker-row"

export type ModelPickerResult = Pick<ModelChoice, "id" | "effort"> | undefined

export type ModelPickerProps = {
  current: string | undefined
  currentEffort?: string | undefined
  onPick: (choice: Pick<ModelChoice, "id" | "effort">) => void
  onCancel: () => void
}

function ModelPicker(props: ModelPickerProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Memoised so adding vendors later (codex) doesn't recompute on every
  // key event. The list is stable for the dialog's lifetime.
  const models = createMemo(() => modelPickerModelOptions(allModels()))
  const [selectedModel, setSelectedModel] = createSignal<ModelPickerModelOption | undefined>()
  const effortChoices = createMemo(() => {
    const model = selectedModel()
    return model ? modelPickerEffortOptions(model) : []
  })

  // Cursor starts on the currently-pinned model so a single enter
  // re-confirms the existing choice without changing it. When unpinned,
  // seed on the active vendor's resolved default so the picker reflects
  // what the user is actually running.
  const seed = props.current ?? defaultCapabilities.defaultModelId()
  const initial = models().findIndex((m) => m.id === seed)
  const [cursor, setCursor] = createSignal(initial >= 0 ? initial : 0)
  const [effortCursor, setEffortCursor] = createSignal(0)
  const inEffortStep = () => selectedModel() !== undefined

  function setInitialEffortCursor(model: ModelPickerModelOption): void {
    const efforts = modelPickerEffortOptions(model)
    const idx = efforts.findIndex((choice) => choice.effort === props.currentEffort)
    setEffortCursor(idx >= 0 ? idx : 0)
  }

  function commit(): void {
    if (inEffortStep()) {
      commitEffort()
      return
    }
    const model = models()[cursor()]
    if (!model) return
    const efforts = modelPickerEffortOptions(model)
    if (efforts.length <= 1 && efforts[0]?.effort === undefined) {
      props.onPick({ id: model.id, effort: undefined })
      dialog.clear()
      return
    }
    setSelectedModel(model)
    setInitialEffortCursor(model)
  }

  function commitEffort(): void {
    const model = selectedModel()
    if (!model) return
    const choice = effortChoices()[effortCursor()]
    if (!choice) return
    props.onPick({ id: model.id, effort: choice.effort })
    dialog.clear()
  }

  function backToModels(): void {
    setSelectedModel(undefined)
  }

  useBindings(() => ({
    bindings: [
      {
        key: "up",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c - 1 + n) % n)
          else setCursor((c) => (c - 1 + n) % n)
        },
      },
      {
        key: "down",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => (c + 1) % n)
        },
      },
      {
        key: "k",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c - 1 + n) % n)
          else setCursor((c) => (c - 1 + n) % n)
        },
      },
      {
        key: "j",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => (c + 1) % n)
        },
      },
      { key: "left", cmd: backToModels },
      { key: "h", cmd: backToModels },
      { key: "return", cmd: commit },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {inEffortStep() ? "Pick effort" : "Pick a model"}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      {inEffortStep() ? (
        <box flexDirection="column" paddingBottom={1}>
          <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted} wrapMode="none">
              model
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {selectedModel()?.label}
            </text>
          </box>
          <For each={effortChoices()}>
            {(choice, i) => {
              const active = () => i() === effortCursor()
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setEffortCursor(i())
                    props.onPick({ id: choice.id, effort: choice.effort })
                    dialog.clear()
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
      ) : (
        <box flexDirection="column" paddingBottom={1}>
          <For each={models()}>
            {(model, i) => {
              const active = () => i() === cursor()
              const hasEfforts = () => modelPickerEffortOptions(model).some((choice) => choice.effort !== undefined)
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    const efforts = modelPickerEffortOptions(model)
                    if (efforts.length <= 1 && efforts[0]?.effort === undefined) {
                      props.onPick({ id: model.id, effort: undefined })
                      dialog.clear()
                      return
                    }
                    setCursor(i())
                    setSelectedModel(model)
                    setInitialEffortCursor(model)
                  }}
                >
                  <text
                    fg={active() ? theme.selectedListItemText : theme.text}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {active() ? "▸ " : "  "}
                    {model.label}
                  </text>
                  <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {model.vendor}
                  </text>
                  {hasEfforts() ? (
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      effort…
                    </text>
                  ) : null}
                  {model.hint ? (
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      {model.hint}
                    </text>
                  ) : null}
                </box>
              )
            }}
          </For>
        </box>
      )}
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          {inEffortStep() ? "↑↓ pick · enter select · h back · esc cancel" : "↑↓ pick · enter select · esc cancel"}
        </text>
      </box>
    </box>
  )
}

ModelPicker.show = (
  dialog: DialogContext,
  current: string | undefined,
  currentEffort?: string | undefined,
): Promise<ModelPickerResult> => {
  return new Promise<ModelPickerResult>((resolve) => {
    dialog.replace(
      () => (
        <ModelPicker
          current={current}
          currentEffort={currentEffort}
          onPick={(choice) => resolve(choice)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export { ModelPicker }
