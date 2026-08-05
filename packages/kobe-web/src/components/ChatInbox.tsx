/**
 * ChatInbox — the attention queue as a dropdown panel under the INBOX
 * header (the /chat shell's ONE jump surface). Items come from the daemon's
 * durable attention inbox (attention.inbox channel, oldest first); clicking
 * one jumps to its task and dismisses the episode via attention.dismiss —
 * mirroring the TUI's visit-resolves rule from the queue's side.
 */

import { useEffect, useMemo, useRef } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { relativeTime } from "../lib/time.ts"
import type { AttentionItem, Task } from "../lib/types.ts"

/** Inbox glyph per state — the sidebar's state vocabulary, same colors. */
function itemGlyph(state: AttentionItem["state"]): {
  glyph: string
  className: string
} {
  switch (state) {
    case "permission_needed":
      return { glyph: "?", className: "text-kobe-yellow" }
    case "rate_limited":
      return { glyph: "◷", className: "text-kobe-yellow" }
    case "error":
      return { glyph: "✕", className: "text-kobe-red" }
    default:
      return { glyph: "●", className: "text-primary" }
  }
}

function itemLabel(state: AttentionItem["state"]): string {
  switch (state) {
    case "permission_needed":
      return "needs input"
    case "rate_limited":
      return "rate limited"
    case "error":
      return "error"
    default:
      return "turn complete"
  }
}

export function ChatInbox({
  onJump,
  onClose,
}: {
  /** Jump to the episode's task (the panel dismisses the episode itself). */
  onJump: (taskId: string) => void
  onClose: () => void
}) {
  const { attentionInbox, tasks } = useAppState()
  const panelRef = useRef<HTMLDivElement>(null)

  const taskById = useMemo(
    () => new Map<string, Task>(tasks.map((t) => [t.id, t])),
    [tasks],
  )
  // Oldest first (queue order); drop episodes whose task no longer exists.
  const items = useMemo(
    () =>
      [...attentionInbox]
        .filter((item) => taskById.has(item.taskId))
        .sort((a, b) => a.at - b.at),
    [attentionInbox, taskById],
  )

  // Click-away + escape close the panel.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const open = (item: AttentionItem): void => {
    onJump(item.taskId)
    onClose()
    // Visit resolves the episode — same contract as the TUI. Best-effort:
    // a failed dismiss just leaves the item for the next visit.
    void rpc("attention.dismiss", {
      taskId: item.taskId,
      tabId: item.tabId ?? undefined,
      at: item.at,
    }).catch(() => {})
  }

  return (
    <div
      ref={panelRef}
      className="absolute left-2 top-11 z-50 w-72 overflow-hidden rounded-md border border-line bg-menu shadow-xl"
    >
      <div className="border-b border-line px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        Inbox — {items.length} waiting
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-subtle">
          Nothing needs you. Sessions that finish a turn, hit an error, or wait
          on a permission land here.
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto py-1">
          {items.map((item) => {
            const task = taskById.get(item.taskId)
            const g = itemGlyph(item.state)
            return (
              <button
                key={`${item.taskId}:${item.tabId ?? ""}:${item.at}`}
                type="button"
                onClick={() => open(item)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-inset"
              >
                <span className={`w-3 shrink-0 text-[12px] ${g.className}`}>
                  {g.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-fg">
                    {task?.title || task?.branch || item.taskId}
                  </span>
                  <span className="block text-[11px] text-subtle">
                    {itemLabel(item.state)}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-subtle">
                  {relativeTime(new Date(item.at).toISOString())}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
