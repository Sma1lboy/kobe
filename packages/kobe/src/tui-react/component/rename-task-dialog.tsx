/** @jsxImportSource @opentui/react */
/**
<<<<<<< HEAD
 * Single-field rename dialog — React port of
 * `src/tui/component/rename-task-dialog/` (issue #15 G3), view + `show`
 * entry point in one file. Same contract: the current value is pre-filled,
 * Enter commits (empty/whitespace-only is a no-op unless `allowEmpty`),
 * esc cancels via the dialog stack, and `RenameTaskDialog.show(dialog,
 * current, opts)` resolves the new value or `undefined` on cancel.
 * `stripNewlines` / `isBlankText` come from the shared framework-free
 * new-task-dialog state module.
=======
 * React rename dialog (issue #15, G3W2) — the
 * `src/tui/component/rename-task-dialog/` counterpart, view + `show`
 * entry in one file (the Solid split exists only for its folder
 * convention). Same contract: single pre-filled input, Enter commits,
 * esc cancels via the dialog stack; `dialogTitle` / `fieldLabel` /
 * `submitLabel` overrides let it double for chat-tab renames, branch
 * names, launch commands, etc.
 *
 * `stripNewlines` / `isBlankText` come from the shared framework-free
 * `state.ts` — same sanitiser as the new-task dialog (opentui `<input>`
 * inserts a literal `\n` on Enter; `isBlankText` rejects full-width
 * space-only titles that `.trim()` misses).
>>>>>>> origin/main
 */

import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { isBlankText, stripNewlines } from "../../tui/component/new-task-dialog/state"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { type DialogContext, useDialog } from "../ui/dialog"

export function RenameTaskDialogView(props: {
  currentTitle: string
  dialogTitle?: string
  /** Inner field label — override for non-title reuses (e.g. `"command"`). */
  fieldLabel?: string
  /** Footer verb shown after `enter`. Defaults to `"rename"`. */
  submitLabel?: string
  /** Input placeholder. Defaults to {@link currentTitle}. */
  placeholder?: string
  /** Allow submitting an empty value (e.g. "blank = default"). Default false. */
  allowEmpty?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const [value, setValue] = useState(props.currentTitle)

<<<<<<< HEAD
  function commit() {
    const v = value.trim()
    // `isBlankText` (not `!v`) so a title made only of full-width spaces
    // counts as empty — `.trim()` does not strip `U+3000`.
=======
  function commit(): void {
    const v = value.trim()
    // `isBlankText` (not `!v`) so a title made only of full-width spaces
    // `　` counts as empty — `.trim()` does not strip `U+3000`.
>>>>>>> origin/main
    if (isBlankText(v) && !props.allowEmpty) return
    props.onSubmit(v)
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.dialogTitle ?? t("common.rename.defaultTitle")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>{props.fieldLabel ?? t("common.rename.defaultFieldLabel")}</text>
        <input
          value={value}
          placeholder={props.placeholder ?? props.currentTitle}
          focused={true}
          onInput={(v: string) => setValue(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          {t("common.rename.footerHint", { submitLabel: props.submitLabel ?? t("common.rename.defaultSubmitLabel") })}
        </text>
      </box>
    </box>
  )
}

/**
<<<<<<< HEAD
 * Open the rename dialog and resolve with the new value (trimmed), or
 * `undefined` when the user cancels — same convention as the Solid entry.
=======
 * Open the rename dialog and resolve with the new title (trimmed) —
 * `undefined` on cancel, matching the other dialogs' convention.
>>>>>>> origin/main
 */
function show(
  dialog: DialogContext,
  currentTitle: string,
  opts: {
    dialogTitle?: string
<<<<<<< HEAD
    fieldLabel?: string
    submitLabel?: string
    placeholder?: string
=======
    /** Inner field label — override for non-title reuses (e.g. `"command"`). */
    fieldLabel?: string
    /** Footer verb after `enter` (default `"rename"`). */
    submitLabel?: string
    /** Input placeholder (default = `currentTitle`). */
    placeholder?: string
    /** Allow submitting an empty value (e.g. "blank = default"). */
>>>>>>> origin/main
    allowEmpty?: boolean
  } = {},
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialogView
          currentTitle={currentTitle}
          dialogTitle={opts.dialogTitle}
          fieldLabel={opts.fieldLabel}
          submitLabel={opts.submitLabel}
          placeholder={opts.placeholder}
          allowEmpty={opts.allowEmpty}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const RenameTaskDialog = {
  show,
}
