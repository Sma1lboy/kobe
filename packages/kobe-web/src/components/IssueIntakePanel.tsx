/**
 * IssueIntakePanel — the Board's Backlog "New" intake, a SlideOver-based panel
 * for capturing an issue (title + markdown description + pasted/dragged images)
 * and either banking it or starting it on the spot. Two actions:
 *
 *   - "Save"                creates the issue only (status `open`).
 *   - "Execute immediately" creates the issue, then quick-starts it on the
 *                           chosen engine/effort (spawn task + first prompt +
 *                           link via Issue.taskId).
 *
 * Images: paste (clipboard files) or drop onto the description uploads through
 * {@link uploadIssueAsset} and splices `![](<url>)` at the caret. Each upload
 * inserts a transient `![](uploading…)` placeholder first, replaced in place
 * when the content-addressed url resolves (or removed on failure) — markdown.ts
 * only renders the resolved `/api/issue-assets/<hash>/<file>` urls as images.
 */

import { type ClipboardEvent, type DragEvent, useRef, useState } from "react"
import { uploadIssueAsset } from "../lib/issue-assets.ts"
import { createIssue, type Issue, quickStartIssue } from "../lib/issues.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { SlideOver } from "./SlideOver.tsx"

/** A unique-ish placeholder token so concurrent uploads don't clobber each
 *  other when their urls resolve out of order. */
let uploadSeq = 0
const placeholderFor = (id: number): string => `![](uploading…#${id})`

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
  const [uploads, setUploads] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = title.trim().length > 0 && !busy

  // Splice `text` into the body at the caret, returning the new caret offset so
  // a follow-up replacement can target the same token.
  const spliceAtCaret = (text: string): void => {
    const el = bodyRef.current
    setBody((prev) => {
      const at = el ? (el.selectionStart ?? prev.length) : prev.length
      const next = prev.slice(0, at) + text + prev.slice(at)
      // Re-place the caret after the inserted text on the next tick.
      requestAnimationFrame(() => {
        if (!el) return
        const pos = at + text.length
        el.selectionStart = pos
        el.selectionEnd = pos
      })
      return next
    })
  }

  // Upload one image file: drop a placeholder at the caret, then swap it for
  // the resolved markdown (or strip it on failure).
  const uploadFile = (file: File): void => {
    const id = ++uploadSeq
    const placeholder = placeholderFor(id)
    spliceAtCaret(placeholder)
    setUploads((n) => n + 1)
    void uploadIssueAsset(repoRoot, file)
      .then(({ url }) => {
        setBody((prev) => prev.replace(placeholder, `![](${url})`))
      })
      .catch((err: unknown) => {
        setBody((prev) => prev.replace(placeholder, ""))
        setError(err instanceof Error ? err.message : "image upload failed")
      })
      .finally(() => setUploads((n) => n - 1))
  }

  const ingestFiles = (files: FileList | null | undefined): boolean => {
    if (!files || files.length === 0) return false
    const images = [...files].filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) return false
    for (const file of images) uploadFile(file)
    return true
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (ingestFiles(event.clipboardData?.files)) event.preventDefault()
  }
  const onDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    if (ingestFiles(event.dataTransfer?.files)) event.preventDefault()
  }
  const onDragOver = (event: DragEvent<HTMLTextAreaElement>): void => {
    // Let the textarea accept the drop instead of the browser navigating to it.
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault()
  }

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
            {uploads > 0 && (
              <span className="ml-auto text-[10px] text-subtle">
                uploading {uploads}…
              </span>
            )}
          </div>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={onDragOver}
            placeholder="context, repro, acceptance (markdown) — paste a screenshot to attach it"
            rows={14}
            className="w-full resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
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
