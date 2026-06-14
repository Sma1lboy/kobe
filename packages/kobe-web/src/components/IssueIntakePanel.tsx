/**
 * IssueIntakePanel — the Issues page's "New issue" intake, a SlideOver-based
 * panel for capturing an issue (title + WYSIWYG markdown description) and
 * either banking it or starting it on the spot. Two actions:
 *
 *   - "Save"                creates the issue only (status `open`).
 *   - "Execute immediately" creates the issue, then quick-starts it on the
 *                           chosen engine/effort (spawn task + first prompt +
 *                           link via Issue.taskId).
 *
 * The description is a single {@link RichEditor} surface: one Notion-like editor
 * that styles markdown inline as you type and shows pasted/dropped images inline
 * (no separate preview pane, no plain textarea). It loads from and emits
 * markdown, which is what the issue store persists.
 */

import { useState } from "react"
import { createIssue, type Issue, quickStartIssue } from "../lib/issues.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { RichEditor } from "./RichEditor.tsx"
import { SlideOver } from "./SlideOver.tsx"

export function IssueIntakePanel({
  repoRoot,
  open,
  onClose,
  onCreated,
}: {
  repoRoot: string
  open: boolean
  onClose: () => void
  /** Fired after a successful create (Save or Execute). For Execute the new
   *  issue is passed so the caller can react to the spawned task. */
  onCreated: (issue: Issue, started: boolean) => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [effort, setEffort] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = title.trim().length > 0 && !busy

  const submit = (execute: boolean): void => {
    if (!canSubmit) return
    const cleanTitle = title.trim()
    setBusy(true)
    setError(null)
    void createIssue(
      repoRoot,
      body.trim() ? { title: cleanTitle, body } : { title: cleanTitle },
    )
      .then(async (state) => {
        const created =
          state.issues.find((i) => i.title === cleanTitle) ?? state.issues[0]
        if (execute && created) {
          await quickStartIssue(repoRoot, created, vendor, effort)
        }
        if (created) onCreated(created, execute)
        // Reset for the next capture, then close.
        setTitle("")
        setBody("")
        onClose()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to create issue")
      })
      .finally(() => setBusy(false))
  }

  const footer = (
    <div className="flex items-center justify-end gap-2 px-3 py-2.5">
      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => submit(false)}
        className="border border-line bg-bg px-3 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => submit(true)}
        className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Starting…" : "Execute immediately"}
      </button>
    </div>
  )

  return (
    <SlideOver open={open} onClose={onClose} title="New issue" footer={footer}>
      <div className="flex flex-col gap-3 p-3">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Title
          </div>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            // biome-ignore lint/a11y/noAutofocus: the panel exists to type a title; focus belongs there on open.
            autoFocus
            className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Description
            </span>
            <span className="text-[10px] text-subtle">
              paste or drop images
            </span>
          </div>
          <RichEditor
            value={body}
            onChange={setBody}
            repoRoot={repoRoot}
            placeholder="context, repro, acceptance — paste a screenshot to attach it"
          />
        </div>

        <EngineEffortPicker
          vendor={vendor}
          effort={effort}
          disabled={busy}
          onChange={(next) => {
            setVendor(next.vendor)
            setEffort(next.effort)
          }}
        />

        {error && (
          <p className="text-[11px] text-kobe-red" role="alert">
            {error}
          </p>
        )}
      </div>
    </SlideOver>
  )
}
