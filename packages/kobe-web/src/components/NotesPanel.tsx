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

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchNotes, saveNotes } from "../lib/notes.ts"

const AUTOSAVE_DEBOUNCE_MS = 600

type SaveState = "idle" | "saving" | "saved" | "error"

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

function statusLabel(state: SaveState): string {
  switch (state) {
    case "saving":
      return "saving…"
    case "saved":
      return "saved"
    case "error":
      return "save failed"
    default:
      return ""
  }
}

export function NotesPanel({
  taskId,
  full = false,
}: {
  taskId: string | null
  full?: boolean
}) {
  const [markdown, setMarkdown] = useState("")
  const [loading, setLoading] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the task the current buffer belongs to, so an in-flight load or
  // a queued autosave for a previous task never writes to the new one.
  const loadedTaskRef = useRef<string | null>(null)

  // Load on task change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    loadedTaskRef.current = taskId
    setSaveState("idle")
    if (!taskId) {
      setMarkdown("")
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
  }, [taskId])

  // Cleanup any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value)
      if (!taskId) return
      const target = taskId
      setSaveState("saving")
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        saveNotes(target, value)
          .then(() => {
            // Only reflect success if we're still on the same task.
            if (loadedTaskRef.current === target) setSaveState("saved")
          })
          .catch(() => {
            if (loadedTaskRef.current === target) setSaveState("error")
          })
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    [taskId],
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-bg">
      <SectionHeader
        right={
          taskId && saveState !== "idle" ? (
            <span
              className={`text-[10px] ${saveState === "error" ? "text-kobe-red" : "text-subtle"}`}
            >
              {statusLabel(saveState)}
            </span>
          ) : null
        }
      >
        Notes
      </SectionHeader>
      <div className={`min-h-0 flex-1 ${full ? "px-0 pb-0" : "px-3 pb-3"}`}>
        {!taskId ? (
          <div className="flex h-full items-center justify-center text-[12px] text-subtle">
            Select a task to take notes.
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
