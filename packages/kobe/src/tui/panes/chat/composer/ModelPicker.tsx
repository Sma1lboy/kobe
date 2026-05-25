/**
 * Model picker dialog — pick which engine model and optional effort
 * level the active chat tab should use on the next spawn/resume.
 *
 * Mirrors {@link DialogConfirm}'s static `show()` shape: returns a
 * Promise that resolves to the chosen model id + effort, or `undefined`
 * when the user dismisses with esc.
 */

import { allModels, getCapabilities } from "@/engine/registry"
import type { ModelChoice } from "@/types/engine"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../../context/theme"
import { useBindings } from "../../../lib/keymap"
import { type DialogContext, useDialog } from "../../../ui/dialog"
import {
  type ModelPickerModelOption,
  type ModelPickerProviderGroup,
  modelPickerDefaultExpandedVendors,
  modelPickerEffortOptions,
  modelPickerProviderGroups,
} from "./model-picker-row"

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

  const seedVendor = props.currentVendor ?? props.lockedVendor ?? "claude"

  // Memoised so adding vendors later (codex) doesn't recompute on every
  // key event. The list is stable for the dialog's lifetime.
  const groups = createMemo(() =>
    modelPickerProviderGroups(allModels(), {
      lockedVendor: props.lockedVendor,
      providerLabelFor: (vendor) => getCapabilities(vendor).label,
    }),
  )
  const [expandedVendors, setExpandedVendors] = createSignal<ReadonlySet<VendorId>>(
    modelPickerDefaultExpandedVendors(props.currentVendor, props.lockedVendor),
  )
  const rows = createMemo(() => visibleRows(groups(), expandedVendors()))
  const [selectedModel, setSelectedModel] = createSignal<ModelPickerModelOption | undefined>()
  const effortChoices = createMemo(() => {
    const model = selectedModel()
    return model ? modelPickerEffortOptions(model) : []
  })

  // Cursor starts on the currently-pinned model so a single enter
  // re-confirms the existing choice without changing it. When unpinned,
  // seed on the active vendor's resolved default so the picker reflects
  // what the user is actually running.
  const seed = props.current ?? getCapabilities(seedVendor).defaultModelId()
  const initial = rows().findIndex((row) => row.type === "model" && row.model.id === seed)
  const [cursor, setCursor] = createSignal(nextEnabledRowIndex(rows(), initial >= 0 ? initial : 0, 1))
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
    const row = rows()[cursor()]
    if (!row) return
    if (row.type === "provider") {
      toggleProvider(row.vendor)
      return
    }
    const model = row.model
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

  function toggleProvider(vendor: VendorId): void {
    setExpandedVendors((previous) => {
      const next = new Set(previous)
      if (next.has(vendor)) next.delete(vendor)
      else next.add(vendor)
      return next
    })
  }

  useBindings(() => ({
    bindings: [
      {
        key: "up",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : rows().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c - 1 + n) % n)
          else setCursor((c) => nextEnabledRowIndex(rows(), c - 1, -1))
        },
      },
      {
        key: "down",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : rows().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => nextEnabledRowIndex(rows(), c + 1, 1))
        },
      },
      {
        key: "k",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : rows().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c - 1 + n) % n)
          else setCursor((c) => nextEnabledRowIndex(rows(), c - 1, -1))
        },
      },
      {
        key: "j",
        cmd: () => {
          const n = inEffortStep() ? effortChoices().length : rows().length
          if (n === 0) return
          if (inEffortStep()) setEffortCursor((c) => (c + 1) % n)
          else setCursor((c) => nextEnabledRowIndex(rows(), c + 1, 1))
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
          <For each={rows()}>
            {(row, i) => {
              const active = () => i() === cursor()
              const disabled = () => row.type === "model" && row.model.disabled === true
              const hasEfforts = () =>
                row.type === "model" &&
                modelPickerEffortOptions(row.model).some((choice) => choice.effort !== undefined)
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() && !disabled() ? theme.primary : undefined}
                  onMouseUp={() => {
                    if (row.type === "provider") {
                      setCursor(i())
                      toggleProvider(row.vendor)
                      return
                    }
                    if (disabled()) return
                    const model = row.model
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
                  {row.type === "provider" ? (
                    <>
                      <text
                        fg={active() ? theme.selectedListItemText : theme.text}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                      >
                        {active() ? "▸ " : "  "}
                        {row.expanded ? "▾" : "▸"} {row.label}
                      </text>
                      <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                        {row.count} models
                      </text>
                    </>
                  ) : (
                    <>
                      <text
                        fg={
                          active() && !disabled()
                            ? theme.selectedListItemText
                            : disabled()
                              ? theme.textMuted
                              : theme.text
                        }
                        attributes={active() && !disabled() ? TextAttributes.BOLD : undefined}
                        wrapMode="none"
                      >
                        {active() ? "▸ " : "  "}
                        {"  "}
                        {row.model.label}
                      </text>
                      {disabled() && row.model.disabledReason ? (
                        <text fg={theme.textMuted} wrapMode="none">
                          {row.model.disabledReason}
                        </text>
                      ) : hasEfforts() ? (
                        <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                          effort…
                        </text>
                      ) : null}
                      {row.model.hint ? (
                        <text
                          fg={active() && !disabled() ? theme.selectedListItemText : theme.textMuted}
                          wrapMode="none"
                        >
                          {row.model.hint}
                        </text>
                      ) : null}
                    </>
                  )}
                </box>
              )
            }}
          </For>
        </box>
      )}
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          {inEffortStep()
            ? "↑↓ pick · enter select · h back · esc cancel"
            : "↑↓ pick · enter select/toggle · esc cancel"}
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

type ModelPickerVisibleRow =
  | {
      readonly type: "provider"
      readonly vendor: VendorId
      readonly label: string
      readonly expanded: boolean
      readonly count: number
    }
  | {
      readonly type: "model"
      readonly model: ModelPickerModelOption
    }

function visibleRows(
  groups: readonly ModelPickerProviderGroup[],
  expandedVendors: ReadonlySet<VendorId>,
): readonly ModelPickerVisibleRow[] {
  const rows: ModelPickerVisibleRow[] = []
  for (const group of groups) {
    const expanded = expandedVendors.has(group.vendor)
    rows.push({
      type: "provider",
      vendor: group.vendor,
      label: group.label,
      expanded,
      count: group.models.length,
    })
    if (expanded) {
      for (const model of group.models) rows.push({ type: "model", model })
    }
  }
  return rows
}

function nextEnabledRowIndex(rows: readonly ModelPickerVisibleRow[], start: number, step: 1 | -1): number {
  if (rows.length === 0) return 0
  const normalized = ((start % rows.length) + rows.length) % rows.length
  for (let offset = 0; offset < rows.length; offset++) {
    const idx = (((normalized + offset * step) % rows.length) + rows.length) % rows.length
    const row = rows[idx]
    if (row?.type === "provider" || !row?.model.disabled) return idx
  }
  return normalized
}
