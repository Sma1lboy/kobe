/**
 * Quick-fork dialog (KOB-74).
 *
 * Fast path from inside a task's chat tab to spin up an exploratory
 * child task. Single-page layout with two stacked regions:
 *
 *   - Model region (top): read-only summary by default ("Current:
 *     <model> · <effort>"). Pressing enter while the Model region has
 *     focus opens an inline picker — first model list, then (when the
 *     model exposes them) effort levels. Selection auto-flows to the
 *     Prompt region when done.
 *   - Prompt region (bottom): single-line input. Enter commits.
 *
 * State model:
 *   - `field`     ∈ {"model", "prompt"} — which region has keyboard
 *     focus. Tab / shift+tab swap.
 *   - `modelStep` ∈ {"summary", "model-pick", "effort-pick"} — Model
 *     region's sub-view. Only meaningful when `field() === "model"`;
 *     leaving the region (via tab or auto-flow) resets it to summary.
 *
 * Keymap:
 *   - tab / shift+tab : swap focus between Model and Prompt regions.
 *     Always active. Leaving the Model region resets it to summary.
 *   - On Model / summary: enter opens picker (modelStep → "model-pick").
 *   - On Model / model-pick: enter selects the cursor; advances to
 *     "effort-pick" if the model has effort levels, otherwise hands
 *     focus to the Prompt region and resets summary.
 *   - On Model / effort-pick: enter selects the cursor; hands focus to
 *     the Prompt region and resets summary.
 *   - On Model / pick views: j/k/↑/↓ move the cursor.
 *   - On Model / effort-pick: h/← steps back to model-pick.
 *   - On Prompt: native input typing; enter commits.
 *   - esc cancels (handled by DialogProvider stack).
 *
 * The j/k/h/return list bindings are gated `enabled: field() === "model"`
 * — j/k/h are character keys; an unguarded binding would corrupt prompt
 * typing ("quick fork" → "quic for" — k swallowed by the model-list
 * navigation). Same enabled-gate pattern NewTaskDialog uses for its
 * confirm-only return binding.
 */

import { allModels, defaultCapabilities } from "@/engine/registry"
import type { ModelEffortLevel } from "@/types/engine"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import {
  type ModelPickerModelOption,
  modelPickerEffortOptions,
  modelPickerModelOptions,
} from "../../panes/chat/composer/model-picker-row"
import { useDialog } from "../../ui/dialog"
import { stripNewlines } from "../new-task-dialog"

export type QuickForkSubmit = {
  prompt: string
  modelId: string
  effort: ModelEffortLevel | undefined
  vendor: VendorId
}

export type QuickForkDialogProps = {
  /** Absolute path of the source task's repo. Shown as a basename. */
  repo: string
  /** Branch/HEAD inherited as the new worktree's base ref. */
  baseRef: string
  /** Inherited model id from the source task's active tab. */
  modelId: string | undefined
  /** Inherited reasoning/effort level from the source tab. */
  effort: ModelEffortLevel | undefined
  onSubmit: (result: QuickForkSubmit) => void
  onCancel: () => void
}

type Field = "model" | "prompt"
type ModelStep = "summary" | "model-pick" | "effort-pick"

export function QuickForkDialogView(props: QuickForkDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Memoised model catalog — stable for dialog lifetime.
  const models = createMemo(() => modelPickerModelOptions(allModels()))

  // Seed cursor on the inherited model so a single enter re-confirms.
  const seedModelId = props.modelId ?? defaultCapabilities.defaultModelId()
  const initialModelIdx = () => {
    const idx = models().findIndex((m) => m.id === seedModelId)
    return idx >= 0 ? idx : 0
  }
  const [modelCursor, setModelCursor] = createSignal(initialModelIdx())

  const cursorModel = createMemo<ModelPickerModelOption | undefined>(() => models()[modelCursor()])

  const effortOptions = createMemo(() => {
    const m = cursorModel()
    return m ? modelPickerEffortOptions(m) : []
  })

  // Effort step only entered when the model has any non-default level.
  const hasEffortChoice = createMemo(() => effortOptions().some((o) => o.effort !== undefined))

  const [effortCursor, setEffortCursor] = createSignal(0)
  createEffect(() => {
    const opts = effortOptions()
    const idx = opts.findIndex((o) => o.effort === props.effort)
    setEffortCursor(idx >= 0 ? idx : 0)
  })

  const [prompt, setPrompt] = createSignal("")
  // Default focus = Prompt region: the common case is "inherit + just
  // give me the prompt". Override path: press tab to swap to the Model
  // region, then enter to open the picker.
  const [field, setField] = createSignal<Field>("prompt")
  const [modelStep, setModelStep] = createSignal<ModelStep>("summary")

  // Pretty label for the inherited / picked model+effort.
  const modelSummary = createMemo(() => {
    const m = cursorModel()
    if (!m) return "—"
    const effort = effortOptions()[effortCursor()]?.effort
    return effort ? `${m.label} · ${effort}` : m.label
  })

  function commit() {
    const text = prompt().trim()
    if (!text) return
    const m = cursorModel()
    if (!m) return
    const effort = effortOptions()[effortCursor()]?.effort
    props.onSubmit({ prompt: text, modelId: m.id, effort, vendor: m.vendor })
    dialog.clear()
  }

  // Always reset the Model region to its summary view when focus
  // leaves; the picker only lives inside the Model region.
  function focusPrompt() {
    setField("prompt")
    setModelStep("summary")
  }

  function focusModel() {
    setField("model")
    setModelStep("summary")
  }

  function switchField() {
    if (field() === "prompt") focusModel()
    else focusPrompt()
  }

  // Enter behavior on the Model region. Sub-step transitions:
  //   summary      → model-pick
  //   model-pick   → effort-pick if model has effort, else focus prompt
  //   effort-pick  → focus prompt
  function modelTabAdvance() {
    if (modelStep() === "summary") {
      setModelStep("model-pick")
      return
    }
    if (modelStep() === "model-pick") {
      if (hasEffortChoice()) {
        setModelStep("effort-pick")
      } else {
        focusPrompt()
      }
      return
    }
    // effort-pick
    focusPrompt()
  }

  // Tab/shift+tab — always active. <input> doesn't consume tab.
  useBindings(() => ({
    bindings: [
      { key: "tab", cmd: switchField },
      { key: "shift+tab", cmd: switchField },
    ],
  }))

  // Model-region bindings — gated so prompt typing isn't corrupted.
  useBindings(() => ({
    enabled: field() === "model",
    bindings: [
      {
        key: "return",
        cmd: modelTabAdvance,
      },
      {
        key: "up",
        cmd: () => {
          if (modelStep() === "model-pick") {
            const n = models().length
            if (n) setModelCursor((c) => (c - 1 + n) % n)
          } else if (modelStep() === "effort-pick") {
            const n = effortOptions().length
            if (n) setEffortCursor((c) => (c - 1 + n) % n)
          }
        },
      },
      {
        key: "down",
        cmd: () => {
          if (modelStep() === "model-pick") {
            const n = models().length
            if (n) setModelCursor((c) => (c + 1) % n)
          } else if (modelStep() === "effort-pick") {
            const n = effortOptions().length
            if (n) setEffortCursor((c) => (c + 1) % n)
          }
        },
      },
      {
        key: "k",
        cmd: () => {
          if (modelStep() === "model-pick") {
            const n = models().length
            if (n) setModelCursor((c) => (c - 1 + n) % n)
          } else if (modelStep() === "effort-pick") {
            const n = effortOptions().length
            if (n) setEffortCursor((c) => (c - 1 + n) % n)
          }
        },
      },
      {
        key: "j",
        cmd: () => {
          if (modelStep() === "model-pick") {
            const n = models().length
            if (n) setModelCursor((c) => (c + 1) % n)
          } else if (modelStep() === "effort-pick") {
            const n = effortOptions().length
            if (n) setEffortCursor((c) => (c + 1) % n)
          }
        },
      },
      {
        key: "left",
        cmd: () => {
          if (modelStep() === "effort-pick") setModelStep("model-pick")
        },
      },
      {
        key: "h",
        cmd: () => {
          if (modelStep() === "effort-pick") setModelStep("model-pick")
        },
      },
    ],
  }))

  const repoLabel = () => {
    const trimmed = props.repo.replace(/\/+$/, "")
    const last = trimmed.split("/").filter(Boolean).pop()
    return last ?? props.repo
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Fork task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} wrapMode="none">
          Forking from
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {repoLabel()}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          ({props.baseRef})
        </text>
      </box>

      {/* Model region (top). Single-line summary by default; expands
          into a picker after enter. Lowercase "model" label keeps it
          visually parallel with the "prompt" label below. */}
      <box flexDirection="column">
        <Show when={modelStep() === "summary"}>
          <box flexDirection="row" gap={1}>
            <text
              fg={field() === "model" ? theme.accent : theme.textMuted}
              attributes={field() === "model" ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              model:
            </text>
            <text fg={theme.text} wrapMode="none">
              {modelSummary()}
            </text>
          </box>
        </Show>

        <Show when={modelStep() === "model-pick"}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            model
          </text>
          <box flexDirection="column" paddingLeft={2}>
            <For each={models()}>
              {(model, i) => {
                const active = () => i() === modelCursor()
                const hasEfforts = () => modelPickerEffortOptions(model).some((c) => c.effort !== undefined)
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active() ? theme.primary : undefined}
                    onMouseUp={() => {
                      setModelCursor(i())
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
        </Show>

        <Show when={modelStep() === "effort-pick"}>
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted} wrapMode="none">
                model:
              </text>
              <text fg={theme.text} wrapMode="none">
                {cursorModel()?.label}
              </text>
            </box>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              effort
            </text>
            <box flexDirection="column" paddingLeft={2}>
              <For each={effortOptions()}>
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
          </box>
        </Show>
      </box>

      {/* Prompt region (bottom). Always visible. Input only focused when
          field === "prompt"; otherwise the user is interacting with the
          Model region above. */}
      <box gap={0}>
        <text
          fg={field() === "prompt" ? theme.accent : theme.textMuted}
          attributes={field() === "prompt" ? TextAttributes.BOLD : undefined}
        >
          prompt
        </text>
        <input
          value={prompt()}
          placeholder="describe what the new task should do…"
          focused={field() === "prompt"}
          onInput={(v: string) => setPrompt(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          {field() === "prompt"
            ? "tab model · enter create · esc cancel"
            : modelStep() === "summary"
              ? "enter pick · tab prompt · esc cancel"
              : modelStep() === "model-pick"
                ? `↑↓ pick · enter ${hasEffortChoice() ? "effort" : "done"} · esc cancel`
                : "↑↓ pick · enter done · h back · esc cancel"}
        </text>
      </box>
    </box>
  )
}
