/**
 * ChatInbox — the attention Inbox as a centered modal (the /chat shell's
 * ONE jump surface), mirroring the TUI dialog's shape (attention-inbox-
 * core.ts): one list, two sections — every pending attention episode on
 * top (oldest first, queue order), then the RECENT tasks below (most
 * recently updated, minus pending ones and the task you're on). Clicking
 * an episode jumps + dismisses it (visit-resolves); clicking a recent row
 * just jumps. Keyboard: j/k move, enter opens, d dismisses, esc closes —
 * the TUI inbox contract.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { useTabsState } from "../lib/tabs.ts"
import { relativeTime } from "../lib/time.ts"
import type { AttentionItem, Task } from "../lib/types.ts"

const RECENT_LIMIT = 5

type InboxRow =
  | { kind: "attention"; item: AttentionItem }
  | { kind: "recent"; task: Task }

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

function SectionHeader({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-3">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        {children}
      </span>
      <span className="h-px min-w-0 flex-1 bg-line" />
    </div>
  )
}

export function ChatInbox({
  selectedId,
  onJump,
  onClose,
}: {
  /** The task the workspace is on — excluded from RECENT (you're there). */
  selectedId: string | null
  /** Jump to a task (the modal dismisses attention episodes itself). */
  onJump: (taskId: string) => void
  onClose: () => void
}) {
  const { attentionInbox, tasks } = useAppState()
  const { tabsByTask } = useTabsState()

  const taskById = useMemo(
    () => new Map<string, Task>(tasks.map((t) => [t.id, t])),
    [tasks],
  )
  // "task · which tab" beats a bare task name: a task runs several tabs, so
  // the item must say WHOSE turn completed.
  const tabTitle = useCallback(
    (item: AttentionItem): string | null => {
      if (!item.tabId) return null
      const tab = (tabsByTask[item.taskId] ?? []).find(
        (t) => t.id === item.tabId,
      )
      return tab?.title ?? null
    },
    [tabsByTask],
  )
  // Attention section: queue order (oldest first), dead tasks dropped.
  const attention = useMemo(
    () =>
      [...attentionInbox]
        .filter((item) => taskById.has(item.taskId))
        .sort((a, b) => a.at - b.at),
    [attentionInbox, taskById],
  )
  // Recent section: live tasks minus pending + the one you're on, newest
  // activity first. (The TUI ranks by its visit log; the web has no visit
  // log yet, so task mtime is the stand-in — same fallback the TUI uses
  // for never-visited tasks.)
  const recent = useMemo(() => {
    const pending = new Set(attention.map((item) => item.taskId))
    return tasks
      .filter((t) => !t.archived && !pending.has(t.id) && t.id !== selectedId)
      .sort((a, b) =>
        (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt),
      )
      .slice(0, RECENT_LIMIT)
  }, [tasks, attention, selectedId])

  // Flat selectable rows — section headers are not rows. Same order as
  // rendered: attention first, then recent.
  const rows = useMemo((): InboxRow[] => {
    const out: InboxRow[] = []
    for (const item of attention) out.push({ kind: "attention", item })
    for (const task of recent) out.push({ kind: "recent", task })
    return out
  }, [attention, recent])

  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1))
  }, [cursor, rows.length])

  const openEpisode = useCallback(
    (item: AttentionItem): void => {
      onJump(item.taskId)
      onClose()
      // Visit resolves the episode — same contract as the TUI. Best-effort:
      // a failed dismiss just leaves the item for the next visit.
      void rpc("attention.dismiss", {
        taskId: item.taskId,
        tabId: item.tabId ?? undefined,
        at: item.at,
      }).catch(() => {})
    },
    [onJump, onClose],
  )

  // The modal owns the keyboard — drop focus left in the sidebar search.
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const last = Math.max(0, rows.length - 1)
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((cur) => Math.min(last, cur + 1))
        return
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((cur) => Math.max(0, cur - 1))
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        event.stopPropagation()
        const row = rows[cursor]
        if (!row) return
        if (row.kind === "attention") openEpisode(row.item)
        else {
          onJump(row.task.id)
          onClose()
        }
        return
      }
      if (event.key === "d") {
        event.preventDefault()
        event.stopPropagation()
        const row = rows[cursor]
        if (!row || row.kind !== "attention") return
        // Dismiss only — no jump, no close. Store update drops the row.
        void rpc("attention.dismiss", {
          taskId: row.item.taskId,
          tabId: row.item.tabId ?? undefined,
          at: row.item.at,
        }).catch(() => {})
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cursor, rows, onClose, onJump, openEpisode])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; escape is handled globally above
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="pop-in w-[26rem] overflow-hidden rounded-lg border border-line bg-menu font-mono shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg">
            Inbox
          </span>
          <span className="text-[11px] text-subtle">
            {attention.length} waiting · esc closes
          </span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto pb-2">
          {attention.length === 0 && recent.length === 0 && (
            <div className="px-4 py-5 text-[12px] text-subtle">
              Nothing here yet — sessions that need you and your recent tasks
              both land in this list.
            </div>
          )}
          {attention.length > 0 && (
            <>
              <SectionHeader>Attention</SectionHeader>
              {attention.map((item, i) => {
                const task = taskById.get(item.taskId)
                const g = itemGlyph(item.state)
                const active = cursor === i
                return (
                  <button
                    key={`${item.taskId}:${item.tabId ?? ""}:${item.at}`}
                    type="button"
                    onClick={() => openEpisode(item)}
                    className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-inset${
                      active ? " bg-inset" : ""
                    }`}
                  >
                    <span className={`w-3 shrink-0 text-[12px] ${g.className}`}>
                      {g.glyph}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">
                        {task?.title || task?.branch || item.taskId}
                        {tabTitle(item) && (
                          <span className="text-muted"> · {tabTitle(item)}</span>
                        )}
                      </span>
                      <span className="block text-[11px] text-subtle">
                        {itemLabel(item.state)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-subtle">
                      {relativeTime(new Date(item.at).toISOString())}
                    </span>
                  </button>
                )
              })}
            </>
          )}
          {recent.length > 0 && (
            <>
              <SectionHeader>Recent</SectionHeader>
              {recent.map((task, i) => {
                const flatIndex = attention.length + i
                const active = cursor === flatIndex
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => {
                      onJump(task.id)
                      onClose()
                    }}
                    className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-inset${
                      active ? " bg-inset" : ""
                    }`}
                  >
                    <span className="w-3 shrink-0 text-[12px] text-subtle">
                      ○
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                      {task.title || task.branch || task.repo}
                    </span>
                    <span className="shrink-0 text-[10px] text-subtle">
                      {relativeTime(task.updatedAt || task.createdAt)}
                    </span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
