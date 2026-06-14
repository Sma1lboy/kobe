/**
 * IssuePeek — the unified Board's detail drawer onto one issue, and the
 * owner-specified START surface for turning an issue into a task. It rides the
 * shared {@link SlideOver} chrome (right-docked, slide-in, focus-trapped,
 * Esc/backdrop close) and opens editable: title (input) + body (textarea)
 * saved via the issues update op, an {@link EngineEffortPicker} (engine +
 * reasoning/effort, both engine-owned), and a START button that spawns + links
 * a task on the chosen engine/effort. Issue cards are NOT draggable — this
 * drawer is how an issue crosses into the task lanes.
 *
 * The body renders through the safe markdown pipeline (the NotesPanel
 * precedent), which now also renders `![](…)` images for the bridge's own
 * issue-asset urls.
 */

import { ExternalLink, Pencil, Play } from "lucide-react"
import { useMemo, useState } from "react"
import { engineLabel, useEngines } from "../lib/engines.ts"
import { canQuickStart, type Issue, STATUS_META } from "../lib/issues.ts"
import { renderMarkdown } from "../lib/markdown.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { SlideOver } from "./SlideOver.tsx"
import "./notes-markdown.css"

export function IssuePeek({
  issue,
  busy,
  quickStartBusy,
  onClose,
  onQuickStart,
  onSave,
  onOpenSession,
}: {
  issue: Issue
  /** A mutation (update) is in flight — actions disable. */
  busy: boolean
  quickStartBusy: boolean
  onClose: () => void
  /** Start the issue on the chosen engine/effort — the wiring slice forwards
   *  both into quickStartIssue(repoRoot, issue, vendor, effort). */
  onQuickStart: (vendor?: string, effort?: string) => void
  onSave: (patch: { title: string; body: string }) => Promise<boolean>
  /** Open the running session/workspace for an already-started (linked) issue. */
  onOpenSession?: () => void
}) {
  const engines = useEngines()
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [effort, setEffort] = useState<string | undefined>(undefined)

  // The issue is already represented by a live task card on the board, so
  // there is nothing left to start. Done issues likewise have nothing to do.
  const linked = Boolean(issue.taskId)
  const startable = canQuickStart(issue.status) && !linked
  const startDisabled = quickStartBusy || !startable

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
    if (linked) return "Started"
    return `Start on ${engineLabel(engines, vendor)}`
  }, [quickStartBusy, linked, engines, vendor])

  const meta = STATUS_META[issue.status]

  const title = (
    <span className="flex items-center gap-2">
      <span className="shrink-0 font-mono text-[11px] text-subtle">
        #{issue.id}
      </span>
      <span className="min-w-0 truncate">{issue.title}</span>
      {!editing && (
        <button
          type="button"
          onClick={beginEdit}
          className="ml-auto flex shrink-0 items-center gap-1 text-muted transition-colors hover:text-fg"
          title="Edit title and body"
        >
          <Pencil size={13} strokeWidth={1.8} />
          <span className="text-[11px]">Edit</span>
        </button>
      )}
    </span>
  )

  // A started (linked) issue is already running — the drawer's job there is to
  // get you to the live session, not to re-pick an engine. An un-started issue
  // shows the engine/effort picker + Start.
  const footer = editing ? undefined : linked ? (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <button
        type="button"
        onClick={() => onOpenSession?.()}
        disabled={!onOpenSession}
        title="Open this issue's running session in the workspace"
        className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ExternalLink size={12} strokeWidth={1.8} />
        Open workspace
      </button>
    </div>
  ) : (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <EngineEffortPicker
        vendor={vendor}
        effort={effort}
        disabled={!startable}
        onChange={(next) => {
          setVendor(next.vendor)
          setEffort(next.effort)
        }}
      />
      <button
        type="button"
        disabled={startDisabled}
        onClick={() => onQuickStart(vendor, effort)}
        title={
          startable
            ? `Start a kobe task on this issue (${engineLabel(engines, vendor)})`
            : "Done issues have nothing left to start"
        }
        className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Play size={12} strokeWidth={1.8} />
        {startLabel}
      </button>
    </div>
  )

  return (
    <SlideOver open onClose={onClose} title={title} footer={footer}>
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
      </div>

      <div className="p-3">
        {editing ? (
          <form
            className="flex flex-col gap-2"
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
              rows={12}
              className="w-full resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
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
    </SlideOver>
  )
}
