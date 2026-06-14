/**
 * IssuePeek — the unified Board's wide ticket-detail drawer onto one issue, and
 * the owner-specified START surface for turning an issue into a task. It rides
 * the shared {@link SlideOver} chrome in its `wide` two-column shell
 * (right-docked, slide-in, focus-trapped, Esc/backdrop close) and splits into:
 *
 *   - LEFT (primary): the ticket itself — an always-editable title <input> and a
 *     markdown description <textarea>. The description accepts pasted/dragged
 *     images through {@link uploadIssueAsset} (the IssueIntakePanel pattern): a
 *     transient `![](uploading…)` placeholder is spliced at the caret, then
 *     swapped for `![](<url>)` once the content-addressed url resolves. A "Save"
 *     affordance lights up when the draft differs from the issue.
 *   - RIGHT (a w-72 detail rail): execution config + metadata — the status chip,
 *     created date, a "running" line for a linked issue, and the engine-owned
 *     {@link EngineEffortPicker}. Its bottom holds the start actions.
 *
 * Start actions (owner-explicit): an un-started, startable issue gets TWO
 * buttons — "Start in background" (spawn + stay on the board) and "Start &
 * watch" (spawn + open the live session). A linked issue swaps both for a single
 * "Open workspace". A done issue has nothing to start.
 *
 * markdown.ts only renders the resolved `/api/issue-assets/<hash>/<file>` urls
 * as images, so the paste/upload + render paths stay XSS-safe by construction.
 */

import { ExternalLink, Play } from "lucide-react"
import { type ClipboardEvent, type DragEvent, useRef, useState } from "react"
import { uploadIssueAsset } from "../lib/issue-assets.ts"
import { canQuickStart, type Issue, STATUS_META } from "../lib/issues.ts"
import { renderMarkdown } from "../lib/markdown.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { SlideOver } from "./SlideOver.tsx"
import "./notes-markdown.css"

/** A unique-ish placeholder token so concurrent uploads don't clobber each
 *  other when their urls resolve out of order (lifted from IssueIntakePanel). */
let uploadSeq = 0
const placeholderFor = (id: number): string => `![](uploading…#${id})`

export function IssuePeek({
  issue,
  repoRoot,
  busy,
  starting,
  onClose,
  onSave,
  onStart,
  onOpenSession,
}: {
  issue: Issue
  /** Source repo for asset uploads — the same key the Board peeks under. */
  repoRoot: string
  /** A save mutation is in flight — the Save affordance disables. */
  busy: boolean
  /** A start spawn is in flight — both start buttons disable. */
  starting: boolean
  onClose: () => void
  /** Persist the edited ticket; resolves true on success so we can clear dirty. */
  onSave: (patch: { title: string; body: string }) => Promise<boolean>
  /** Start the issue on the chosen engine/effort. `watch` opens the live
   *  session immediately; otherwise the spawn stays in the background. */
  onStart: (opts: { vendor?: string; effort?: string; watch: boolean }) => void
  /** Open the running session/workspace for an already-started (linked) issue. */
  onOpenSession?: () => void
}) {
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [effort, setEffort] = useState<string | undefined>(undefined)
  const [uploads, setUploads] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [bodyTab, setBodyTab] = useState<"write" | "preview">("write")
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // The issue is already represented by a live task card on the board, so there
  // is nothing left to start. Done issues likewise have nothing to do.
  const linked = Boolean(issue.taskId)
  const startable = canQuickStart(issue.status) && !linked
  const dirty = draftTitle !== issue.title || draftBody !== issue.body
  const canSave = dirty && draftTitle.trim().length > 0 && !busy

  const meta = STATUS_META[issue.status]

  /* ----- image paste/drop (IssueIntakePanel pattern) --------------------- */

  // Splice `text` into the body at the caret, re-placing the caret after it so a
  // follow-up replacement can target the same placeholder token.
  const spliceAtCaret = (text: string): void => {
    const el = bodyRef.current
    setDraftBody((prev) => {
      const at = el ? (el.selectionStart ?? prev.length) : prev.length
      const next = prev.slice(0, at) + text + prev.slice(at)
      requestAnimationFrame(() => {
        if (!el) return
        const pos = at + text.length
        el.selectionStart = pos
        el.selectionEnd = pos
      })
      return next
    })
  }

  // Upload one image file: drop a placeholder at the caret, then swap it for the
  // resolved markdown (or strip it on failure).
  const uploadFile = (file: File): void => {
    const id = ++uploadSeq
    const placeholder = placeholderFor(id)
    spliceAtCaret(placeholder)
    setUploads((n) => n + 1)
    void uploadIssueAsset(repoRoot, file)
      .then(({ url }) => {
        setDraftBody((prev) => prev.replace(placeholder, `![](${url})`))
      })
      .catch((err: unknown) => {
        setDraftBody((prev) => prev.replace(placeholder, ""))
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

  const save = (): void => {
    if (!canSave) return
    setError(null)
    void onSave({ title: draftTitle, body: draftBody }).catch(
      (err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to save issue")
      },
    )
  }

  const title = (
    <span className="flex items-center gap-2">
      <span className="shrink-0 font-mono text-[11px] text-subtle">
        #{issue.id}
      </span>
      <span className="min-w-0 truncate">{issue.title}</span>
    </span>
  )

  return (
    <SlideOver open wide onClose={onClose} title={title}>
      <div className="flex h-full min-h-0">
        {/* LEFT — the editable ticket. */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 border-r border-line p-3">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Title
            </div>
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Issue title"
              className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
                Description
              </span>
              <div className="flex items-center gap-1">
                {(["write", "preview"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBodyTab(t)}
                    className={`px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                      bodyTab === t
                        ? "border-b border-primary text-fg"
                        : "text-subtle hover:text-fg"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-subtle">paste or drop images</span>
              {uploads > 0 && (
                <span className="ml-auto text-[10px] text-subtle">
                  uploading {uploads}…
                </span>
              )}
            </div>
            {bodyTab === "write" ? (
              <textarea
                ref={bodyRef}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                onPaste={onPaste}
                onDrop={onDrop}
                onDragOver={onDragOver}
                placeholder="context, repro, acceptance (markdown) — paste a screenshot to attach it"
                className="min-h-[200px] w-full flex-1 resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
              />
            ) : draftBody.trim() ? (
              <div
                className="kobe-md min-h-[200px] flex-1 overflow-auto border border-line bg-bg px-2 py-1.5 text-[12px] leading-relaxed text-fg"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all input first + only emits images for resolved /api/issue-assets urls (lib/markdown.ts; tested).
                dangerouslySetInnerHTML={{ __html: renderMarkdown(draftBody) }}
              />
            ) : (
              <div className="min-h-[200px] flex-1 border border-line bg-bg px-2 py-1.5 text-[12px] text-subtle">
                Nothing to preview.
              </div>
            )}
          </div>

          {error && (
            <p className="text-[11px] text-kobe-red" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!canSave}
              onClick={save}
              title={dirty ? "Save title and body" : "No unsaved changes"}
              className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* RIGHT — execution config + metadata, split into labeled sections so
            future settings/detail each get their own slot (add a sibling
            <section> between Detail and Engine, or after Engine). */}
        <div className="flex w-72 shrink-0 flex-col gap-4 p-3">
          {/* DETAIL */}
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Detail
            </h3>
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-bold uppercase tracking-[0.12em] ${meta.accent}`}
              >
                {meta.title}
              </span>
              <span className="font-mono text-[10px] text-subtle">
                created {issue.created}
              </span>
            </div>
            {linked && issue.taskId && (
              <span
                className="flex items-center gap-1.5 font-mono text-[10px] text-kobe-orange"
                title={`Linked to task ${issue.taskId}`}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-kobe-orange" />
                running
              </span>
            )}
          </section>

          {/* ENGINE — its own section; future settings/detail get sibling
              sections beside it. */}
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Engine
            </h3>
            <EngineEffortPicker
              vendor={vendor}
              effort={effort}
              disabled={!startable}
              onChange={(next) => {
                setVendor(next.vendor)
                setEffort(next.effort)
              }}
            />
          </section>

          {/* Actions pinned to the rail bottom. */}
          <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
            {linked ? (
              <>
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
                <span className="text-center text-[10px] text-subtle">
                  Started
                </span>
              </>
            ) : startable ? (
              <>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => onStart({ vendor, effort, watch: false })}
                  title="Spawn a kobe task on this issue and stay on the board"
                  className="flex h-8 items-center justify-center gap-1.5 border border-line bg-bg px-3 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} strokeWidth={1.8} />
                  {starting ? "Starting…" : "Start in background"}
                </button>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => onStart({ vendor, effort, watch: true })}
                  title="Spawn a kobe task and open its live session"
                  className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} strokeWidth={1.8} />
                  {starting ? "Starting…" : "Start & watch"}
                </button>
              </>
            ) : (
              <p className="text-center text-[10px] text-subtle">
                Done issues have nothing left to start.
              </p>
            )}
          </div>
        </div>
      </div>
    </SlideOver>
  )
}
