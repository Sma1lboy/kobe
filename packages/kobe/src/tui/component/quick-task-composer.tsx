import { TextAttributes } from "@opentui/core"
import { usePaste } from "@opentui/solid"
import { For, Show, createSignal } from "solid-js"
import type { VendorId } from "../../types/task"
import { nextVendorWithin } from "../../types/vendor"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { asAttachmentPaths, attachmentLabel, captureClipboardAttachment } from "../lib/attachments"
import { useBindings } from "../lib/keymap"
import type { DialogContext } from "../ui/dialog"
import { useDialog } from "../ui/dialog"
import { isBlankText, stripNewlines } from "./new-task-dialog"
import { quickTaskBindings } from "./quick-task-bindings"

export interface QuickTaskComposerOptions {
  readonly repoLabel: string
  readonly engines: readonly VendorId[]
  readonly defaultVendor: VendorId
  readonly defaultBaseRef: string
  readonly engineLabel: (vendor: VendorId) => string
}

export interface QuickTaskResult {
  readonly prompt: string
  readonly vendor: VendorId
  readonly baseRef: string
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
  const [field, setField] = createSignal<Field>("prompt")
  const [prompt, setPrompt] = createSignal("")
  const [vendor, setVendor] = createSignal<VendorId>(props.defaultVendor)
  const [baseRef, setBaseRef] = createSignal(props.defaultBaseRef)
  const [attachments, setAttachments] = createSignal<readonly string[]>([])

  usePaste((event: { bytes: Uint8Array; preventDefault: () => void }) => {
    const paths = asAttachmentPaths(new TextDecoder().decode(event.bytes))
    if (!paths) return
    event.preventDefault()
    setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))])
  })

  function pasteAttachment(): void {
    void captureClipboardAttachment().then((path) => {
      if (path) setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]))
    })
  }

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
    if (isBlankText(prompt())) {
      setField("prompt")
      return
    }
    props.onSubmit({
      prompt: prompt().trim(),
      vendor: vendor(),
      baseRef: baseRef().trim() || props.defaultBaseRef,
      attachments: attachments(),
    })
    dialog.clear()
  }

  useBindings(() => ({
    enabled: true,
    bindings: quickTaskBindings(field(), {
      cycleField,
      stepEngine,
      commit,
      pasteAttachment,
      removeLastAttachment: () => setAttachments((prev) => prev.slice(0, -1)),
    }),
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

      <Show when={attachments().length > 0}>
        <box flexDirection="row" gap={2} flexWrap="wrap">
          <For each={attachments()}>
            {(path, i) => (
              <text fg={theme.primary} onMouseUp={() => setAttachments((prev) => prev.filter((p) => p !== path))}>
                {attachmentLabel(path, i())}
              </text>
            )}
          </For>
        </box>
      </Show>

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
