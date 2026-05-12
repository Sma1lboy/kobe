/**
 * Quick-fork dialog (KOB-74).
 *
 * Fast path from inside a task's chat tab to spin up an exploratory
 * child task. The user has already chosen the repo, branch, and model
 * by being in the source task — we just need a prompt. The dialog is
 * compact: a read-only "Forking from" summary plus one prompt input.
 *
 * Inheritance is decided by the caller (see use-task-actions.ts) and
 * surfaced here as already-resolved strings so the dialog has no
 * orchestrator coupling.
 *
 * Layout / convention notes:
 *   - `<input>` (single-line) keeps the dialog short — the quick-fork
 *     gesture is for short exploratory prompts. Multi-line drafts
 *     belong in the full new-task flow / composer.
 *   - Enter submits (the input's own onSubmit fires); esc cancels via
 *     the DialogProvider stack-level binding.
 *   - Empty/whitespace-only submits no-op so a stray Enter doesn't
 *     create a task with an empty first turn.
 *   - `stripNewlines` is shared with the other text dialogs — opentui's
 *     `<input>` quirk that inserts a literal `\n` on Enter.
 */

import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { stripNewlines } from "../new-task-dialog"

export type QuickForkDialogProps = {
  /** Absolute path of the source task's repo. Shown as a basename. */
  repo: string
  /** Branch/HEAD inherited as the new worktree's base ref. */
  baseRef: string
  /** Pretty model label inherited by the new task's first tab. */
  modelLabel: string
  onSubmit: (prompt: string) => void
  onCancel: () => void
}

export function QuickForkDialogView(props: QuickForkDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [prompt, setPrompt] = createSignal("")

  function commit() {
    const text = prompt().trim()
    if (!text) return
    props.onSubmit(text)
    dialog.clear()
  }

  // Compact basename so the summary row stays readable on narrow
  // terminals — the full path is /Users/...long stuff; basename is
  // just the directory name.
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
      {/* Inherited summary: read-only labels in one line per fact.
          Avoids nested <text> (opentui's TextRenderable doesn't merge
          children's styles cleanly — siblings within a flex row keep
          their own color attributes). */}
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
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} wrapMode="none">
          Model:
        </text>
        <text fg={theme.text} wrapMode="none">
          {props.modelLabel}
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>prompt</text>
        <input
          value={prompt()}
          placeholder="describe what the new task should do…"
          focused={true}
          onInput={(v: string) => setPrompt(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>enter create · esc cancel</text>
      </box>
    </box>
  )
}
