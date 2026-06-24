/**
 * Prompt-first quick-task composer (`<prefix> f`).
 *
 * The quick path is prompt-first: the PROMPT field is focused on open and
 * `enter` from it creates the task immediately. Engine and branch are right
 * there too — `tab` cycles prompt → engine → branch, `ctrl+e` (or ←/→ on the
 * engine field) switches engine — but they default from the firing task, so
 * the common path is just "type a prompt, hit enter".
 *
 * This is deliberately NOT the full `NewTaskDialog` (repo picker, clone/adopt
 * tabs) and NOT `RenameTaskDialog` (whose field is literally labelled
 * "title" / "rename" — wrong for a prompt). It's the small, create-focused
 * surface the quick chord wants.
 */

import { TextAttributes } from "@opentui/core"
import { For, createSignal } from "solid-js"
import type { VendorId } from "../../types/task"
import { nextVendorWithin } from "../../types/vendor"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import type { DialogContext } from "../ui/dialog"
import { useDialog } from "../ui/dialog"
import { stripNewlines } from "./new-task-dialog"
import { quickTaskBindings } from "./quick-task-bindings"

export interface QuickTaskComposerOptions {
  /** Header context, e.g. the repo basename the task lands in. */
  readonly repoLabel: string
  /** Engines to offer (detected built-ins + custom), in cycle order. */
  readonly engines: readonly VendorId[]
  /** Pre-selected engine (last-selected, clamped to a detected one). */
  readonly defaultVendor: VendorId
  /** Pre-filled base branch (repo's current branch, else main). */
  readonly defaultBaseRef: string
  /** Display label for an engine id (custom name override, else the id). */
  readonly engineLabel: (vendor: VendorId) => string
}

export interface QuickTaskResult {
  readonly prompt: string
  readonly vendor: VendorId
  readonly baseRef: string
}

type Field = "prompt" | "engine" | "branch"
const FIELDS: readonly Field[] = ["prompt", "engine", "branch"]

function QuickTaskComposerView(
  props: QuickTaskComposerOptions & {
    onSubmit: (result: QuickTaskResult) => void
    onCancel: () => void
  },
) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [field, setField] = createSignal<Field>("prompt")
  const [prompt, setPrompt] = createSignal("")
  const [vendor, setVendor] = createSignal<VendorId>(props.defaultVendor)
  const [baseRef, setBaseRef] = createSignal(props.defaultBaseRef)

  function cycleField(dir: 1 | -1): void {
    const i = FIELDS.indexOf(field())
    setField(FIELDS[(i + dir + FIELDS.length) % FIELDS.length] ?? "prompt")
  }
  function stepEngine(dir: 1 | -1): void {
    const list = props.engines
    if (list.length === 0) return
    if (dir > 0) {
      setVendor((v) => nextVendorWithin(list, v))
      return
    }
    const i = Math.max(0, list.indexOf(vendor()))
    setVendor(list[(i - 1 + list.length) % list.length] ?? vendor())
  }
  function commit(): void {
    const p = prompt().trim()
    if (!p) {
      setField("prompt") // a prompt is required — bounce focus back to it
      return
    }
    props.onSubmit({ prompt: p, vendor: vendor(), baseRef: baseRef().trim() || props.defaultBaseRef })
    dialog.clear()
  }

  // The engine-only chords (←/→ cycle, enter commit) are gated at
  // REGISTRATION, not inside the handler: a matched binding consumes the
  // keypress (dispatchKeyEvent calls preventDefault on every hit), so a
  // handler-side `if (field() === "engine")` still STOLE the key from the
  // focused input — Enter in the prompt field never reached the input's
  // onSubmit (the "type a prompt, hit enter" path was dead) and ←/→
  // couldn't move the cursor in the prompt/branch inputs. The list comes
  // from the pure `quickTaskBindings` (vitest pins the gating); the
  // config thunk re-runs per keypress, so it tracks `field()` live.
  useBindings(() => ({
    enabled: true,
    bindings: quickTaskBindings(field(), { cycleField, stepEngine, commit }),
  }))

  const fieldColor = (f: Field) => (field() === f ? theme.accent : theme.textMuted)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("quickTask.title", { repoLabel: props.repoLabel })}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          {t("quickTask.esc")}
        </text>
      </box>

      <box gap={0}>
        <text fg={fieldColor("prompt")}>{t("quickTask.promptLabel")}</text>
        <input
          value={prompt()}
          placeholder={t("quickTask.promptPlaceholder")}
          focused={field() === "prompt"}
          onInput={(v: string) => setPrompt(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box flexDirection="row" gap={2}>
        <text fg={fieldColor("engine")}>{t("quickTask.engineLabel")}</text>
        <For each={props.engines}>
          {(v) => (
            <text
              fg={vendor() === v ? theme.primary : theme.textMuted}
              attributes={vendor() === v ? TextAttributes.BOLD : undefined}
              onMouseUp={() => {
                setVendor(v)
                setField("engine")
              }}
            >
              {props.engineLabel(v)}
            </text>
          )}
        </For>
      </box>

      <box gap={0}>
        <text fg={fieldColor("branch")}>{t("quickTask.branchLabel")}</text>
        <input
          value={baseRef()}
          placeholder={props.defaultBaseRef}
          focused={field() === "branch"}
          onInput={(v: string) => setBaseRef(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("quickTask.legend")}</text>
      </box>
    </box>
  )
}

function show(dialog: DialogContext, opts: QuickTaskComposerOptions): Promise<QuickTaskResult | undefined> {
  return new Promise<QuickTaskResult | undefined>((resolve) => {
    dialog.replace(
      () => <QuickTaskComposerView {...opts} onSubmit={(r) => resolve(r)} onCancel={() => resolve(undefined)} />,
      () => resolve(undefined),
    )
    dialog.setSize("medium")
  })
}

export const QuickTaskComposer = { show }
