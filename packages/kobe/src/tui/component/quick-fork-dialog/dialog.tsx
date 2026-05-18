/**
 * Quick-fork dialog (KOB-74, branch picker KOB-203).
 *
 * Fast path from inside a task's chat tab to spin up an exploratory
 * child task. Single-page layout with three stacked regions:
 *
 *   - Model region (top): read-only summary by default ("Current:
 *     <model> · <effort>"). Pressing enter while the Model region has
 *     focus opens an inline picker — first model list, then (when the
 *     model exposes them) effort levels. Selection auto-flows to the
 *     Branch region when done.
 *   - Branch region (middle): read-only summary by default ("branch:
 *     <baseRef>") seeded from the source task's current branch. Enter
 *     opens an inline input + filtered branch list — same primitives
 *     as new-task-dialog's branch picker. Auto-flows to Prompt.
 *   - Prompt region (bottom): single-line input. Enter commits.
 *
 * State model:
 *   - `field`      ∈ {"model", "branch", "prompt"} — which region has
 *     keyboard focus. Tab / shift+tab cycle.
 *   - `modelStep`  ∈ {"summary", "model-pick", "effort-pick"} — Model
 *     region's sub-view. Only meaningful when `field() === "model"`;
 *     leaving the region resets it to summary.
 *   - `branchStep` ∈ {"summary", "branch-pick"} — Branch region's
 *     sub-view. Only meaningful when `field() === "branch"`; leaving
 *     resets to summary.
 *
 * Keymap:
 *   - tab / shift+tab : cycle focus Model → Branch → Prompt → Model.
 *     Leaving any region resets its sub-view to summary.
 *   - On Model / summary: enter opens picker (modelStep → "model-pick").
 *   - On Model / model-pick: enter selects; advances to "effort-pick"
 *     if model has effort levels, else focuses Branch.
 *   - On Model / effort-pick: enter selects; focuses Branch.
 *   - On Model / pick views: j/k/↑/↓ move the cursor.
 *   - On Model / effort-pick: h/← steps back to model-pick.
 *   - On Branch / summary: enter opens picker (branchStep →
 *     "branch-pick"); the input is then focused for typing.
 *   - On Branch / branch-pick: ↑/↓ navigate the filtered branch list;
 *     enter resolves the highlighted branch (or typed text) and focuses
 *     Prompt. (j/k are not bound here — they're character keys the
 *     focused input must receive verbatim.)
 *   - On Prompt: native input typing; enter commits.
 *   - esc cancels (handled by DialogProvider stack).
 *
 * The j/k/h/return list bindings are gated `enabled: field() === "model"`
 * — j/k/h are character keys; an unguarded binding would corrupt prompt
 * typing ("quick fork" → "quic for" — k swallowed by the model-list
 * navigation). Branch-pick bindings are gated `enabled: field() ===
 * "branch"` for the same reason.
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
import {
  DEFAULT_BASE_REF,
  type PickerWindow,
  clampCursor,
  filterBranches,
  listLocalBranches,
  resolveBaseRef,
  windowAround,
} from "../new-task-dialog/state"

export type QuickForkSubmit = {
  prompt: string
  modelId: string
  effort: ModelEffortLevel | undefined
  vendor: VendorId
  /**
   * Base ref the new worktree should fork from. Defaults to the
   * inherited `baseRef` prop (read from the source task's current
   * branch); the user may override via the in-dialog branch picker.
   */
  baseRef: string
}

export type QuickForkDialogProps = {
  /** Absolute path of the source task's repo. Shown as a basename. */
  repo: string
  /**
   * Branch/HEAD inherited as the new worktree's base ref. Used to
   * pre-fill the Branch region so a single Enter through the dialog
   * forks from the same branch the user was just on.
   */
  baseRef: string
  /** Inherited model id from the source task's active tab. */
  modelId: string | undefined
  /** Inherited reasoning/effort level from the source tab. */
  effort: ModelEffortLevel | undefined
  onSubmit: (result: QuickForkSubmit) => void
  onCancel: () => void
}

type Field = "model" | "branch" | "prompt"
type ModelStep = "summary" | "model-pick" | "effort-pick"
type BranchStep = "summary" | "branch-pick"

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
  // or Branch region.
  const [field, setField] = createSignal<Field>("prompt")
  const [modelStep, setModelStep] = createSignal<ModelStep>("summary")
  const [branchStep, setBranchStep] = createSignal<BranchStep>("summary")

  // Branch state. Seeded from props.baseRef so a single Enter through
  // the dialog forks from the inherited branch. `baseRefTouched` mirrors
  // new-task-dialog: once the user has typed into the branch input we
  // stop re-running the resolve step on every cursor move.
  const [baseRef, setBaseRef] = createSignal(props.baseRef)
  const [baseRefTouched, setBaseRefTouched] = createSignal(false)
  const branches = createMemo<readonly string[]>(() => listLocalBranches(props.repo))
  const branchFiltered = createMemo<readonly string[]>(() => filterBranches(branches(), baseRef()))
  const [branchCursor, setBranchCursor] = createSignal(0)
  const branchWindow = createMemo<PickerWindow>(() => windowAround(branchFiltered(), branchCursor()))

  // Keep the branch cursor in sync with the filtered list:
  //   - Untouched: cursor tracks the inherited `props.baseRef` so
  //     opening the picker lands the highlight on what the user is
  //     already forking from (falls back to 0 when the inherited ref
  //     isn't a local branch — tag / sha / HEAD-detached fallback).
  //   - Touched: cursor snaps back to 0 on every filter narrow so the
  //     highlight never sits on a now-hidden row.
  createEffect(() => {
    const list = branchFiltered()
    if (baseRefTouched()) {
      setBranchCursor(0)
      return
    }
    const idx = list.findIndex((b) => b === props.baseRef)
    setBranchCursor(idx >= 0 ? idx : 0)
  })

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
    // Prefer the highlighted branch over typed text — same precedence
    // new-task-dialog uses. Falls back to DEFAULT_BASE_REF when both
    // are empty so the orchestrator never sees a blank baseRef.
    const finalBaseRef = resolveBaseRef(baseRef(), branchFiltered(), branchCursor())
    props.onSubmit({ prompt: text, modelId: m.id, effort, vendor: m.vendor, baseRef: finalBaseRef })
    dialog.clear()
  }

  // Always reset region sub-views when focus leaves them; the pickers
  // only live inside their own regions.
  function focusPrompt() {
    setField("prompt")
    setModelStep("summary")
    setBranchStep("summary")
  }

  function focusModel() {
    setField("model")
    setModelStep("summary")
    setBranchStep("summary")
  }

  function focusBranch() {
    setField("branch")
    setModelStep("summary")
    setBranchStep("summary")
  }

  function switchField() {
    if (field() === "prompt") focusModel()
    else if (field() === "model") focusBranch()
    else focusPrompt()
  }

  // Enter behavior on the Model region. Sub-step transitions:
  //   summary      → model-pick
  //   model-pick   → effort-pick if model has effort, else focus branch
  //   effort-pick  → focus branch
  function modelTabAdvance() {
    if (modelStep() === "summary") {
      setModelStep("model-pick")
      return
    }
    if (modelStep() === "model-pick") {
      if (hasEffortChoice()) {
        setModelStep("effort-pick")
      } else {
        focusBranch()
      }
      return
    }
    // effort-pick
    focusBranch()
  }

  // Enter behavior on the Branch region. Sub-step transitions:
  //   summary     → branch-pick (input takes focus)
  //   branch-pick → resolve highlight / typed text, focus prompt
  function branchTabAdvance() {
    if (branchStep() === "summary") {
      setBranchStep("branch-pick")
      return
    }
    // branch-pick — commit the highlighted branch (or typed free text)
    // and move on to the prompt. Touching baseRef here keeps the
    // resolve idempotent for the "user pressed enter without typing"
    // path: the input shows whatever they picked, not a stale prefix.
    setBaseRef(resolveBaseRef(baseRef(), branchFiltered(), branchCursor()))
    setBaseRefTouched(true)
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

  // Branch-region bindings. Gated on focus so the underlying input
  // gets character keys verbatim — only the navigation keys (up/down)
  // and the picker-advance enter are intercepted. j/k are NOT bound
  // here: they're character keys the branch input must receive (e.g.
  // typing "kobe/feature/foo" must not be eaten by the picker).
  useBindings(() => ({
    enabled: field() === "branch",
    bindings: [
      {
        key: "return",
        cmd: branchTabAdvance,
      },
      {
        key: "up",
        cmd: () => {
          if (branchStep() !== "branch-pick") return
          const n = branchFiltered().length
          if (!n) return
          setBranchCursor(clampCursor(branchCursor() - 1, n))
        },
      },
      {
        key: "down",
        cmd: () => {
          if (branchStep() !== "branch-pick") return
          const n = branchFiltered().length
          if (!n) return
          setBranchCursor(clampCursor(branchCursor() + 1, n))
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
        {/* Top-line summary tracks the user's branch selection — the
            inherited `props.baseRef` is the initial value, but if the
            user picks a different branch in the picker below the
            summary follows so the header stays truthful. */}
        <text fg={theme.textMuted} wrapMode="none">
          ({baseRef() || props.baseRef})
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

      {/* Branch region (middle). Single-line summary by default — same
          pattern as Model. Pressing enter opens an inline input + filtered
          branch list (reusing new-task-dialog's primitives). Picks
          flow back into baseRef(); the resolved value is what commit()
          sends. */}
      <box flexDirection="column">
        <Show when={branchStep() === "summary"}>
          <box flexDirection="row" gap={1}>
            <text
              fg={field() === "branch" ? theme.accent : theme.textMuted}
              attributes={field() === "branch" ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              branch:
            </text>
            <text fg={theme.text} wrapMode="none">
              {baseRef() || props.baseRef || DEFAULT_BASE_REF}
            </text>
          </box>
        </Show>

        <Show when={branchStep() === "branch-pick"}>
          <box gap={0}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              branch
            </text>
            <input
              value={baseRef()}
              placeholder={props.baseRef || DEFAULT_BASE_REF}
              focused={field() === "branch" && branchStep() === "branch-pick"}
              onInput={(v: string) => {
                setBaseRefTouched(true)
                setBaseRef(stripNewlines(v))
              }}
              onSubmit={() => branchTabAdvance()}
            />
            <Show when={branchFiltered().length === 0}>
              <box gap={0} paddingLeft={2}>
                <text fg={theme.textMuted} wrapMode="none">
                  {branches().length === 0
                    ? "(no local branches — typed text will be used as ref)"
                    : "(no match — typed text will be used as ref)"}
                </text>
              </box>
            </Show>
            <Show when={branchFiltered().length > 0}>
              <box gap={0} paddingLeft={2}>
                <Show when={branchWindow().start > 0}>
                  <text fg={theme.textMuted} wrapMode="none">
                    ↑ {branchWindow().start} more
                  </text>
                </Show>
                <For each={branchWindow().items}>
                  {(name, i) => {
                    const absoluteIndex = () => branchWindow().start + i()
                    const isCursor = () => absoluteIndex() === branchCursor()
                    const isSelected = () => baseRef().trim() === name
                    return (
                      <text
                        fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                        attributes={isCursor() ? TextAttributes.BOLD : undefined}
                        wrapMode="none"
                        onMouseUp={() => {
                          setBaseRef(name)
                          setBaseRefTouched(true)
                          setBranchCursor(absoluteIndex())
                          focusPrompt()
                        }}
                      >
                        {isCursor() ? "▸ " : "  "}
                        {name}
                      </text>
                    )
                  }}
                </For>
                <Show when={branchWindow().start + branchWindow().items.length < branchWindow().total}>
                  <text fg={theme.textMuted} wrapMode="none">
                    ↓ {branchWindow().total - branchWindow().start - branchWindow().items.length} more
                  </text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
      </box>

      {/* Prompt region (bottom). Always visible. Input only focused when
          field === "prompt"; otherwise the user is interacting with the
          Model or Branch region above. */}
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
            : field() === "branch"
              ? branchStep() === "summary"
                ? "enter pick · tab prompt · esc cancel"
                : "↑↓ pick · enter done · tab prompt · esc cancel"
              : modelStep() === "summary"
                ? "enter pick · tab branch · esc cancel"
                : modelStep() === "model-pick"
                  ? `↑↓ pick · enter ${hasEffortChoice() ? "effort" : "branch"} · esc cancel`
                  : "↑↓ pick · enter branch · h back · esc cancel"}
        </text>
      </box>
    </box>
  )
}
