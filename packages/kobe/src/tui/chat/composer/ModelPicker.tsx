/**
 * Model picker dialog — pick which engine model and optional effort
 * level the active chat tab should use on the next spawn/resume.
 *
 * Mirrors {@link DialogConfirm}'s static `show()` shape: returns a
 * Promise that resolves to the chosen model id + effort, or `undefined`
 * when the user dismisses with esc.
 */

import { allModels, getCapabilities } from "@/engine/registry"
import { useTheme } from "@/tui/context/theme"
import { t } from "@/tui/i18n"
import { useBindings } from "@/tui/lib/keymap"
import { type DialogContext, useDialog } from "@/tui/ui/dialog"
import type { ModelChoice } from "@/types/engine"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, createMemo, createSignal } from "solid-js"
import { type ModelPickerModelOption, modelPickerEffortOptions, modelPickerModelOptions } from "./model-picker-row"

export type ModelPickerResult = Pick<ModelChoice, "vendor" | "id" | "effort"> | undefined

export type ModelPickerProps = {
  current: string | undefined
  currentEffort?: string | undefined
  currentVendor?: VendorId | undefined
  lockedVendor?: VendorId | undefined
  onPick: (choice: Pick<ModelChoice, "vendor" | "id" | "effort">) => void
  onCancel: () => void
}

function ModelPicker(props: ModelPickerProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Memoised so adding vendors later (codex) doesn't recompute on every
  // key event. The list is stable for the dialog's lifetime.
  const models = createMemo(() => modelPickerModelOptions(allModels(), { lockedVendor: props.lockedVendor }))
  const [selectedModel, setSelectedModel] = createSignal<ModelPickerModelOption | undefined>()
  const effortChoices = createMemo(() => {
    const model = selectedModel()
    return model ? modelPickerEffortOptions(model) : []
  })

  // Cursor starts on the currently-pinned model so a single enter
  // re-confirms the existing choice without changing it. When unpinned,
  // seed on the active vendor's resolved default so the picker reflects
  // what the user is actually running.
  const seedVendor = props.currentVendor ?? props.lockedVendor ?? DEFAULT_TASK_VENDOR
  const seed = props.current ?? getCapabilities(seedVendor)?.defaultModelId()
  const initial = models().findIndex((m) => m.id === seed)
  const [cursor, setCursor] = createSignal(nextEnabledIndex(models(), initial >= 0 ? initial : 0, 1))
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
    if (model.disabled) return
    const efforts = modelPickerEffortOptions(model)
    if (efforts.length <= 1 && efforts[0]?.effort === undefined) {
      props.onPick({ vendor: model.vendor, id: model.id, effort: undefined })
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
    props.onPick({ vendor: model.vendor, id: model.id, effort: choice.effort })
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
          else setCursor((c) => nextEnabledIndex(models(), c - 1, -1))
        },
      },
      {
        key: "down",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => nextEnabledIndex(models(), c + 1, 1))
        },
      },
      {
        key: "k",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c - 1 + n) % n)
          else setCursor((c) => nextEnabledIndex(models(), c - 1, -1))
        },
      },
      {
        key: "j",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : models().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => nextEnabledIndex(models(), c + 1, 1))
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
          {inEffortStep() ? t("chat.composer.pickEffort") : t("chat.composer.pickModel")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          {t("chat.composer.esc")}
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
                    const model = selectedModel()
                    if (!model) return
                    setEffortCursor(i())
                    props.onPick({ vendor: model.vendor, id: choice.id, effort: choice.effort })
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
              const disabled = () => model.disabled === true
              const hasEfforts = () => modelPickerEffortOptions(model).some((choice) => choice.effort !== undefined)
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() && !disabled() ? theme.primary : undefined}
                  onMouseUp={() => {
                    if (disabled()) return
                    const efforts = modelPickerEffortOptions(model)
                    if (efforts.length <= 1 && efforts[0]?.effort === undefined) {
                      props.onPick({ vendor: model.vendor, id: model.id, effort: undefined })
                      dialog.clear()
                      return
                    }
                    setCursor(i())
                    setSelectedModel(model)
                    setInitialEffortCursor(model)
                  }}
                >
                  <text
                    fg={
                      active() && !disabled() ? theme.selectedListItemText : disabled() ? theme.textMuted : theme.text
                    }
                    attributes={active() && !disabled() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {active() ? "▸ " : "  "}
                    {model.label}
                  </text>
                  <text fg={active() && !disabled() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {model.vendor}
                  </text>
                  {disabled() && model.disabledReason ? (
                    <text fg={theme.textMuted} wrapMode="none">
                      {model.disabledReason}
                    </text>
                  ) : hasEfforts() ? (
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      effort…
                    </text>
                  ) : null}
                  {model.hint ? (
                    <text fg={active() && !disabled() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
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
          {inEffortStep() ? t("chat.composer.pickerHintEffort") : t("chat.composer.pickerHint")}
        </text>
      </box>
    </box>
  )
}

ModelPicker.show = (
  dialog: DialogContext,
  current: string | undefined,
  currentEffort?: string | undefined,
  currentVendor?: VendorId | undefined,
  lockedVendor?: VendorId | undefined,
): Promise<ModelPickerResult> => {
  return new Promise<ModelPickerResult>((resolve) => {
    dialog.replace(
      () => (
        <ModelPicker
          current={current}
          currentEffort={currentEffort}
          currentVendor={currentVendor}
          lockedVendor={lockedVendor}
          onPick={(choice) => resolve(choice)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export { ModelPicker }

function nextEnabledIndex(models: readonly ModelPickerModelOption[], start: number, step: 1 | -1): number {
  if (models.length === 0) return 0
  const normalized = ((start % models.length) + models.length) % models.length
  for (let offset = 0; offset < models.length; offset++) {
    const idx = (((normalized + offset * step) % models.length) + models.length) % models.length
    if (!models[idx]?.disabled) return idx
  }
  return normalized
}
