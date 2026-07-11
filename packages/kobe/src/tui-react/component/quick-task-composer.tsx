/** @jsxImportSource @opentui/react */
/**
 * Prompt-first quick-task composer (`<prefix> f`) — React port of
 * `src/tui/component/quick-task-composer.tsx`.
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
import { usePaste } from "@opentui/react"
import { useState } from "react"
import { isBlankText, stripNewlines } from "../../tui/component/new-task-dialog/state"
import { asAttachmentPaths, attachmentLabel, captureClipboardAttachment } from "../../tui/lib/attachments"
import type { VendorId } from "../../types/task"
import { nextVendorWithin } from "../../types/vendor"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"
import { ChoiceRow } from "./new-task-dialog/picker-list"
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
  /** Absolute file paths (images/PDFs) to reference alongside the prompt. */
  readonly attachments: readonly string[]
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
  const t = useT()
  const [field, setField] = useState<Field>("prompt")
  const [prompt, setPrompt] = useState("")
  const [vendor, setVendor] = useState<VendorId>(props.defaultVendor)
  const [baseRef, setBaseRef] = useState(props.defaultBaseRef)
  const [attachments, setAttachments] = useState<readonly string[]>([])

  // Pasted text that is entirely image/PDF path(s) (Finder copy, drag-drop)
  // becomes attachments instead of prompt text. This global paste hook runs
  // BEFORE the focused input's own paste handler, so preventDefault() stops
  // the path from also being inserted as text. Ordinary text falls through.
  usePaste((event: { bytes: Uint8Array; preventDefault: () => void }) => {
    const paths = asAttachmentPaths(new TextDecoder().decode(event.bytes))
    if (!paths) return
    event.preventDefault()
    setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))])
  })

  // ctrl+v: a raw clipboard image (screenshot) or copied file never arrives
  // as paste text — ask the OS clipboard directly. Async + best-effort.
  function pasteAttachment(): void {
    void captureClipboardAttachment().then((path) => {
      if (path) setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]))
    })
  }

  function cycleField(dir: 1 | -1): void {
    setField((f) => {
      const i = FIELDS.indexOf(f)
      return FIELDS[(i + dir + FIELDS.length) % FIELDS.length] ?? "prompt"
    })
  }
  function stepEngine(dir: 1 | -1): void {
    const list = props.engines
    if (list.length === 0) return
    if (dir > 0) {
      setVendor((v) => nextVendorWithin(list, v))
      return
    }
    setVendor((v) => {
      const i = Math.max(0, list.indexOf(v))
      return list[(i - 1 + list.length) % list.length] ?? v
    })
  }
  function commit(): void {
    if (isBlankText(prompt)) {
      // A prompt is required — bounce focus back to it. `isBlankText`
      // (not `.trim()`) so a prompt of only full-width spaces `　`
      // (common when typing Chinese) is rejected, not silently submitted.
      setField("prompt")
      return
    }
    props.onSubmit({
      prompt: prompt.trim(),
      vendor,
      baseRef: baseRef.trim() || props.defaultBaseRef,
      attachments,
    })
    dialog.clear()
  }

  // The engine-only chords (←/→ cycle, enter commit) are gated at
  // REGISTRATION, not inside the handler: a matched binding consumes the
  // keypress (dispatchKeyEvent calls preventDefault on every hit), so a
  // handler-side `if (field === "engine")` still STOLE the key from the
  // focused input — Enter in the prompt field never reached the input's
  // onSubmit (the "type a prompt, hit enter" path was dead) and ←/→
  // couldn't move the cursor in the prompt/branch inputs. The list comes
  // from the pure `quickTaskBindings` (vitest pins the gating); the
  // config thunk re-runs per keypress, so it tracks `field` live.
  useBindings(() => ({
    enabled: true,
    bindings: quickTaskBindings(field, {
      cycleField,
      stepEngine,
      commit,
      pasteAttachment,
      removeLastAttachment: () => setAttachments((prev) => prev.slice(0, -1)),
    }),
  }))

  const fieldColor = (f: Field) => (field === f ? theme.accent : theme.textMuted)

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
          value={prompt}
          placeholder={t("quickTask.promptPlaceholder")}
          focused={field === "prompt"}
          onInput={(v: string) => setPrompt(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      {attachments.length > 0 ? (
        <box flexDirection="row" gap={2} flexWrap="wrap">
          {attachments.map((path, i) => (
            <text
              key={path}
              fg={theme.primary}
              onMouseUp={() => setAttachments((prev) => prev.filter((p) => p !== path))}
            >
              {attachmentLabel(path, i)}
            </text>
          ))}
        </box>
      ) : null}

      <ChoiceRow
        choices={props.engines}
        selected={vendor}
        label={<text fg={fieldColor("engine")}>{t("quickTask.engineLabel")}</text>}
        arrow={false}
        display={(v) => props.engineLabel(v)}
        onPick={(v) => {
          setVendor(v)
          setField("engine")
        }}
      />

      <box gap={0}>
        <text fg={fieldColor("branch")}>{t("quickTask.branchLabel")}</text>
        <input
          value={baseRef}
          placeholder={props.defaultBaseRef}
          focused={field === "branch"}
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
  return showDialog<QuickTaskResult>(
    dialog,
    (resolve) => <QuickTaskComposerView {...opts} onSubmit={(r) => resolve(r)} onCancel={() => resolve(undefined)} />,
    { size: "medium" },
  )
}

export const QuickTaskComposer = { show }
