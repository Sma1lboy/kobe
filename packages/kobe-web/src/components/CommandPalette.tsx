/**
 * Command palette (Cmd/Ctrl+K) — a keyboard-first launcher over the same
 * daemon state the rail shows. Fuzzy-matches tasks (jump + set active) and
 * a few global actions (new task, settings). Arrow keys move, Enter runs,
 * Escape closes; opening focuses the query. kobe's TUI is keyboard-first,
 * so its web counterpart gets the same muscle memory.
 *
 * Mounted once by AppShell, which owns the open state and the new-task /
 * settings callbacks (so a "New task" command opens the real dialog).
 */

import { useNavigate } from "@tanstack/react-router"
import {
  ArrowRight,
  LayoutGrid,
  Plus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"

interface Command {
  id: string
  label: string
  hint?: string
  icon: "task" | "new" | "settings" | "overview"
  run: () => void
}

/** Subsequence fuzzy match (every query char appears in order). Cheap and
 *  good enough for a task list; returns a score for ranking (lower = better,
 *  rewards earlier + tighter matches). null = no match. */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti - lastHit // gap penalty: contiguous runs score lowest
      lastHit = ti
      qi++
    }
  }
  return qi === q.length ? score : null
}

function CommandIcon({ kind }: { kind: Command["icon"] }) {
  if (kind === "new") return <Plus size={14} strokeWidth={2} />
  if (kind === "settings") return <SettingsIcon size={14} strokeWidth={1.8} />
  if (kind === "overview") return <LayoutGrid size={14} strokeWidth={1.8} />
  return <ArrowRight size={14} strokeWidth={1.8} />
}

export function CommandPalette({
  open,
  onClose,
  onNewTask,
  onOpenSettings,
}: {
  open: boolean
  onClose: () => void
  onNewTask: () => void
  onOpenSettings: () => void
}) {
  const { tasks } = useAppState()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setCursor(0)
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const taskCmds: Command[] = (tasks as Task[])
      .filter((t) => !t.archived)
      .map((t) => ({
        id: `task:${t.id}`,
        label: t.title || t.branch || t.id,
        hint: t.kind === "main" ? "project" : t.branch,
        icon: "task" as const,
        run: () => {
          selectTask(t.id)
          void rpc("task.setActive", { taskId: t.id }).catch((err) =>
            reportError("switch task", err),
          )
          void navigate({ to: "/task/$taskId", params: { taskId: t.id } })
          onClose()
        },
      }))
    const actions: Command[] = [
      {
        id: "action:new",
        label: "New task",
        hint: "create",
        icon: "new",
        run: () => {
          onNewTask()
          onClose()
        },
      },
      {
        id: "action:overview",
        label: "Open overview",
        hint: "triage",
        icon: "overview",
        run: () => {
          void navigate({ to: "/overview" })
          onClose()
        },
      },
      {
        id: "action:settings",
        label: "Open settings",
        hint: "settings",
        icon: "settings",
        run: () => {
          onOpenSettings()
          onClose()
        },
      },
    ]
    return [...actions, ...taskCmds]
  }, [tasks, navigate, onClose, onNewTask, onOpenSettings])

  const matches = useMemo(() => {
    if (!query.trim()) return commands
    return commands
      .map((cmd) => {
        const haystack = `${cmd.label} ${cmd.hint ?? ""}`
        const score = fuzzyScore(query.trim(), haystack)
        return score === null ? null : { cmd, score }
      })
      .filter((m): m is { cmd: Command; score: number } => m !== null)
      .sort((a, b) => a.score - b.score)
      .map((m) => m.cmd)
  }, [commands, query])

  // Keep the cursor in range as the match list shrinks.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, matches.length - 1)))
  }, [matches.length])

  if (!open) return null

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      matches[cursor]?.run()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; Escape is the keyboard path.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={onClose}
      onKeyDown={() => {}}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[34rem] max-w-[calc(100vw-2rem)] overflow-hidden border border-line bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Search
            size={15}
            strokeWidth={1.8}
            className="shrink-0 text-subtle"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a task or run a command…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
          />
          <kbd className="shrink-0 border border-line px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            esc
          </kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {matches.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">
              No matches for “{query}”.
            </div>
          ) : (
            matches.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                onClick={cmd.run}
                onMouseMove={() => setCursor(index)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
                  index === cursor ? "bg-inset" : "hover:bg-inset/50"
                }`}
              >
                <span
                  className={`shrink-0 ${index === cursor ? "text-primary" : "text-subtle"}`}
                >
                  <CommandIcon kind={cmd.icon} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                  {cmd.label}
                </span>
                {cmd.hint && (
                  <span className="shrink-0 font-mono text-[10px] text-subtle">
                    {cmd.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 font-mono text-[10px] text-subtle">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
