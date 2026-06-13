/**
 * NewIssueDialog — the modal for creating a daemon issue in a repo (title +
 * optional markdown body). Extracted from IssuesPage so the unified Board can
 * create issues without the IssuesPage shell.
 *
 * Props in, callbacks out: the dialog owns only its draft title/body; `onCreate`
 * fires with the trimmed title + raw body, `onClose` dismisses. Backdrop click,
 * Escape, and Cancel all close; a focus trap keeps Tab inside the modal.
 */

import { useRef, useState } from "react"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

export function NewIssueDialog({
  busy,
  onCreate,
  onClose,
}: {
  busy: boolean
  onCreate: (title: string, body: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const canCreate = title.trim().length > 0 && !busy
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a convenience; Escape + the Cancel button are the accessible paths.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose()
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        className="w-[28rem] max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
            New Issue
          </span>
          <span className="font-mono text-[10px] text-subtle">
            daemon store
          </span>
        </div>
        <form
          className="space-y-3 px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (canCreate) onCreate(title.trim(), body)
          }}
        >
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Title
            </div>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to type a title; focus belongs there on open.
              autoFocus
              className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Body
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="optional — context, repro, acceptance (markdown)"
              rows={6}
              className="w-full resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-line bg-bg px-3 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
