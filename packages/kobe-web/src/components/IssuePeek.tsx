/**
 * IssuePeek — the unified Board's right-side drawer onto one issue, and the
 * owner-specified START surface for turning an issue into a task. It opens
 * editable: title (input) + body (textarea) saved via the issues update op,
 * an ENGINE picker (the same engine-owned list NewTaskDialog / the Task-panel
 * vendor grid read), and a START button that spawns + links a task on the
 * chosen engine. Issue cards are NOT draggable — this drawer is how an issue
 * crosses into the task lanes. Structure copies BoardPeek: fixed right drawer,
 * focus trap, Esc/backdrop close. The body still renders through the safe
 * markdown pipeline (the NotesPanel precedent) when not editing.
 */

import { Pencil, Play, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { engineLabel, useEngines } from "../lib/engines.ts"
import {
  canQuickStart,
  type Issue,
  type IssueStatus,
  STATUS_META,
  statusActions,
} from "../lib/issues.ts"
import { renderMarkdown } from "../lib/markdown.ts"
import { fetchDefaultEngine } from "../lib/settings.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"
import "./notes-markdown.css"

export function IssuePeek({
  issue,
  busy,
  quickStartBusy,
  onClose,
  onSetStatus,
  onQuickStart,
  onSave,
}: {
  issue: Issue
  /** A mutation (status/update) is in flight — actions disable. */
  busy: boolean
  quickStartBusy: boolean
  onClose: () => void
  onSetStatus: (to: IssueStatus) => void
  /** Start the issue on the chosen engine — the wiring slice forwards `vendor`
   *  into quickStartIssue(repoRoot, issue, vendor). */
  onQuickStart: (vendor?: string) => void
  onSave: (patch: { title: string; body: string }) => Promise<boolean>
}) {
  const engines = useEngines()
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  const [vendor, setVendor] = useState<string>(engines[0]?.id ?? "claude")
  const [vendorTouched, setVendorTouched] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  // The issue is already represented by a live task card on the board, so
  // there is nothing left to start. Done issues likewise have nothing to do.
  const linked = Boolean(issue.taskId)
  const startable = canQuickStart(issue.status) && !linked
  const startDisabled = quickStartBusy || !startable

  // Default the engine to the user's detected default (same source as
  // NewTaskDialog), unless they've already picked one in the drawer.
  useEffect(() => {
    let cancelled = false
    void fetchDefaultEngine().then((id) => {
      if (cancelled || !id || vendorTouched) return
      setVendor(id)
    })
    return () => {
      cancelled = true
    }
  }, [vendorTouched])

  // View mode opens with focus still on the card behind the backdrop, and
  // the trap only intercepts keydowns INSIDE the panel — move focus into
  // it on mount so Tab/Esc land in the drawer immediately.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Esc closes the drawer — except while typing in a field, where Esc
  // should leave the field alone (the BoardPeek pattern).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      const t = event.target as HTMLElement | null
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const beginEdit = (): void => {
    setDraftTitle(issue.title)
    setDraftBody(issue.body)
    setEditing(true)
  }
  const save = (): void => {
    void onSave({ title: draftTitle, body: draftBody }).then((ok) => {
      if (ok) setEditing(false)
    })
  }

  const startLabel = useMemo(() => {
    if (quickStartBusy) return "Starting…"
    return `Start on ${engineLabel(engines, vendor)}`
  }, [quickStartBusy, engines, vendor])

  const meta = STATUS_META[issue.status]

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close issue"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Issue #${issue.id}: ${issue.title}`}
        tabIndex={-1}
        className="relative flex h-full w-[560px] max-w-[92vw] flex-col border-l border-line bg-bg shadow-2xl focus:outline-none"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <span className="shrink-0 font-mono text-[11px] text-subtle">
            #{issue.id}
          </span>
          <span className="min-w-0 truncate text-[13px] text-fg">
            {issue.title}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={beginEdit}
                className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
                title="Edit title and body"
              >
                <Pencil size={13} strokeWidth={1.8} />
                <span className="text-[11px]">Edit</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex items-center text-muted transition-colors hover:text-fg"
              aria-label="Close issue"
              title="Close (Esc)"
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          </div>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <span
            className={`text-[10px] font-bold uppercase tracking-[0.12em] ${meta.accent}`}
          >
            {meta.title}
          </span>
          <span className="font-mono text-[10px] text-subtle">
            created {issue.created}
          </span>
          {linked && issue.taskId && (
            <span
              className="font-mono text-[10px] text-subtle"
              title={`Linked to task ${issue.taskId}`}
            >
              · started
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {statusActions(issue.status).map((action) => (
              <button
                key={action.to}
                type="button"
                disabled={busy}
                onClick={() => onSetStatus(action.to)}
                title={`Move to ${STATUS_META[action.to].title}`}
                className="border border-line bg-bg px-1.5 py-0.5 text-[10px] text-subtle transition-colors hover:border-primary hover:text-fg disabled:opacity-40"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {editing ? (
            <form
              className="flex h-full flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Issue title"
                // biome-ignore lint/a11y/noAutofocus: edit mode is an explicit user action; focus belongs in the field it opened.
                autoFocus
                className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
              />
              <textarea
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                placeholder="Body (markdown)"
                className="min-h-0 w-full flex-1 resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="border border-line bg-bg px-3 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !draftTitle.trim()}
                  className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:opacity-40"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          ) : issue.body.trim() ? (
            <div
              className="kobe-md text-[12px] leading-relaxed text-fg"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all input first and emits only its own tags (see lib/markdown.ts); covered by tests.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.body) }}
            />
          ) : (
            <p className="text-[12px] text-subtle">No body.</p>
          )}
        </div>

        {!editing && (
          <footer className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
                Engine
              </span>
              <div className="flex flex-wrap gap-1.5">
                {engines.map((engine) => (
                  <button
                    key={engine.id}
                    type="button"
                    disabled={!startable}
                    onClick={() => {
                      setVendorTouched(true)
                      setVendor(engine.id)
                    }}
                    className={`border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      vendor === engine.id
                        ? "border-primary bg-inset text-fg"
                        : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
                    }`}
                  >
                    {engineLabel(engines, engine.id)}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              disabled={startDisabled}
              onClick={() => onQuickStart(vendor)}
              title={
                linked
                  ? "This issue already has a running task"
                  : startable
                    ? `Start a kobe task on this issue (${engineLabel(engines, vendor)})`
                    : "Done issues have nothing left to start"
              }
              className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={12} strokeWidth={1.8} />
              {linked ? "Started" : startLabel}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}
