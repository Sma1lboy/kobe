/**
 * Notes panel (web-only) — a per-task free-form markdown scratchpad.
 *
 * Loads notes when `taskId` changes, edits in a full-height <textarea>,
 * and autosaves on a debounce (~600ms after typing stops). The TUI has no
 * equivalent; notes live server-side under <KOBE_HOME>/.kobe/notes/.
 *
 * Mount this anywhere a task is in focus. The center workspace uses `full`
 * so notes fill the whole tab instead of behaving like a side-panel card.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { renderMarkdown } from "../lib/markdown.ts"
import { fetchNotes, saveNotes } from "../lib/notes.ts"
import { type SaveState, saveStatusLabel } from "../lib/save-state.ts"
import "./notes-markdown.css"

const AUTOSAVE_DEBOUNCE_MS = 600

function SectionHeader({
  children,
  right,
}: {
  children: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        {children}
      </span>
      {right}
    </div>
  )
}

export function NotesPanel({
  taskId,
  full = false,
}: {
  taskId: string | null
  full?: boolean
}) {
  const [markdown, setMarkdown] = useState("")
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const rendered = useMemo(() => renderMarkdown(markdown), [markdown])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the task the current buffer belongs to, so an in-flight load or
  // a queued autosave for a previous task never writes to the new one.
  const loadedTaskRef = useRef<string | null>(null)
  // The newest un-persisted edit, kept so a task switch or an unmount that
  // lands inside the autosave debounce window can FLUSH it instead of dropping
  // it. Carries its own taskId so a flush always writes to the task the text
  // actually belongs to, never the task we're navigating to.
  const pendingSaveRef = useRef<{ taskId: string; value: string } | null>(null)

  // Persist the pending edit right now, cancelling the debounce. A no-op when
  // nothing is pending. The success/error reflection stays target-guarded so a
  // flush for a task we've since left saves the data without stamping a stale
  // status onto the task now on screen.
  const flushPendingSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const pending = pendingSaveRef.current
    if (!pending) return
    pendingSaveRef.current = null
    const { taskId: target, value } = pending
    void saveNotes(target, value)
      .then(() => {
        if (loadedTaskRef.current === target) setSaveState("saved")
      })
      .catch(() => {
        if (loadedTaskRef.current === target) setSaveState("error")
      })
  }, [])

  // Load on task change.
  useEffect(() => {
    // Repoint the ref BEFORE flushing so the outgoing task's queued save can't
    // reflect a stale "saved" onto the incoming task (the flush is target-
    // guarded on this ref). The flush persists an edit made in the last
    // <debounce ms — the old clearTimeout here silently dropped it.
    loadedTaskRef.current = taskId
    flushPendingSave()
    setSaveState("idle")
    // Clear the buffer + drop to Edit mode immediately so the previous task's
    // content (or a stale preview render) can't show during the async reload.
    setMarkdown("")
    setPreview(false)
    if (!taskId) {
      return
    }
    let cancelled = false
    setLoading(true)
    fetchNotes(taskId)
      .then((md) => {
        if (!cancelled && loadedTaskRef.current === taskId) setMarkdown(md)
      })
      .catch(() => {
        if (!cancelled && loadedTaskRef.current === taskId) setMarkdown("")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [taskId, flushPendingSave])

  // Flush (not drop) any pending autosave on unmount, so edits made in the last
  // <debounce ms before the panel closes still reach the server.
  useEffect(() => {
    return () => {
      flushPendingSave()
    }
  }, [flushPendingSave])

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value)
      if (!taskId) return
      const target = taskId
      setSaveState("saving")
      // Stash the newest edit so a flush (task switch / unmount) can persist it
      // even if the debounce hasn't fired yet.
      pendingSaveRef.current = { taskId: target, value }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(flushPendingSave, AUTOSAVE_DEBOUNCE_MS)
    },
    [taskId, flushPendingSave],
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-bg">
      <SectionHeader
        right={
          taskId ? (
            <div className="flex items-center gap-2">
              {saveState !== "idle" && (
                <span
                  className={`text-[10px] ${saveState === "error" ? "text-kobe-red" : "text-subtle"}`}
                >
                  {saveStatusLabel(saveState)}
                </span>
              )}
              <button
                type="button"
                onClick={() => setPreview((p) => !p)}
                className={`border px-1.5 py-0.5 text-[10px] transition-colors ${
                  preview
                    ? "border-primary bg-inset text-fg"
                    : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
                }`}
                title="Toggle markdown preview"
              >
                {preview ? "Edit" : "Preview"}
              </button>
            </div>
          ) : null
        }
      >
        Notes
      </SectionHeader>
      <div className={`min-h-0 flex-1 ${full ? "px-0 pb-0" : "px-3 pb-3"}`}>
        {!taskId ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <div>
              <div className="text-[12px] font-semibold text-fg">
                No task selected
              </div>
              <div className="mt-1 max-w-48 text-[12px] leading-relaxed text-subtle">
                Pick a task to open its web-only scratchpad.
              </div>
            </div>
          </div>
        ) : preview ? (
          <div
            className={`h-full w-full overflow-auto bg-surface px-4 py-3 ${
              full ? "border-t border-line" : "rounded border border-line"
            }`}
          >
            {markdown.trim() ? (
              <div
                className="kobe-md text-[12px] leading-relaxed text-fg"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all input first and emits only its own tags (see lib/markdown.ts); covered by tests.
                dangerouslySetInnerHTML={{ __html: rendered }}
              />
            ) : (
              <p className="text-[12px] text-subtle">Nothing to preview yet.</p>
            )}
          </div>
        ) : (
          <textarea
            value={markdown}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            placeholder={
              loading
                ? "loading notes…"
                : "Notes for this task — markdown, autosaved."
            }
            disabled={loading}
            className={`h-full w-full resize-none border-line bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none disabled:opacity-60 ${
              full ? "border-x-0 border-b-0 border-t" : "rounded border"
            }`}
          />
        )}
      </div>
    </div>
  )
}
