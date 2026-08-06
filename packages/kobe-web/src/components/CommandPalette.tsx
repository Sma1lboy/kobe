/**
 * Command palette (Cmd/Ctrl+K) — a keyboard-first launcher over the same
 * daemon state the rail shows. Fuzzy-matches tasks (jump on the /chat shell)
 * and global actions (new task, Kanban, Routines, settings, reset layout).
 * Arrow keys move, Enter runs, Escape closes; opening focuses the query.
 *
 * Switcher grammar: HOLD ctrl and tap k to cycle next-next-next; releasing
 * ctrl runs the highlighted row. A single ctrl+k then release stays open in
 * typing mode (filter + arrows) — the IDE ctrl+tab feel.
 */

import { useNavigate } from "@tanstack/react-router"
import {
  ArrowRight,
  Columns3,
  Plus,
  Repeat2,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { activityColor } from "../lib/activity.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { selectChatTask, setChatSurface } from "../lib/global-ui.ts"
import { orderTasksForPalette } from "../lib/palette-commands.ts"
import { useAppState } from "../lib/store.ts"
import { resetLayout, selectTask } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

interface Command {
  id: string
  label: string
  hint?: string
  icon: "task" | "new" | "settings" | "board" | "routines" | "reset"
  /** Set for task rows — lets the row render a LIVE engine-activity dot
   *  (read at render, not baked into the memo, so it stays current without
   *  rebuilding the command list on every engine-state push). */
  taskId?: string
  run: () => void
}

function CommandIcon({ kind }: { kind: Command["icon"] }) {
  if (kind === "new") return <Plus size={14} strokeWidth={2} />
  if (kind === "settings") return <SettingsIcon size={14} strokeWidth={1.8} />
  if (kind === "board") return <Columns3 size={14} strokeWidth={1.8} />
  if (kind === "routines") return <Repeat2 size={14} strokeWidth={1.8} />
  if (kind === "reset") return <RotateCcw size={14} strokeWidth={1.8} />
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
  const { tasks, engineStates } = useAppState()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Always-mounted + returns null while closed, so the dialog element only
  // exists once `open` is true — gate the trap on `open` so the effect re-runs
  // (and finds the ref) when the palette opens.
  useFocusTrap(dialogRef, open)

  // Keep the keyboard-highlighted row visible — focus stays in the input, so
  // the browser won't auto-scroll the active button into view (mirrors the
  // rail's j/k scroll-into-view).
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  useEffect(() => {
    if (open) {
      setQuery("")
      setCursor(0)
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    // Task rows ordered by recency + live activity (orderTasksForPalette) so
    // the most-recently-touched tasks float to the top of the palette.
    const taskCmds: Command[] = orderTasksForPalette(tasks as Task[]).map(
      (t) => ({
        id: `task:${t.id}`,
        label: t.title || t.branch || t.id,
        hint: t.kind === "main" ? "project" : t.branch,
        icon: "task" as const,
        taskId: t.id,
        run: () => {
          selectTask(t.id)
          setActiveTaskBestEffort(t.id, (err) =>
            reportError("switch task", err),
          )
          selectChatTask(t.id)
          void navigate({ to: "/" })
          onClose()
        },
      }),
    )
    const openSurface = (surface: "board" | "routines"): void => {
      setChatSurface(surface)
      void navigate({ to: "/" })
      onClose()
    }
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
        id: "action:board",
        label: "Open Kanban",
        hint: "prefix 1",
        icon: "board",
        run: () => openSurface("board"),
      },
      {
        id: "action:routines",
        label: "Open Routines",
        hint: "prefix 2",
        icon: "routines",
        run: () => openSurface("routines"),
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
      {
        id: "action:reset-layout",
        label: "Reset workspace layout",
        hint: "recovery",
        icon: "reset",
        run: () => {
          resetLayout()
          pushToast("info", "Workspace layout reset")
          onClose()
        },
      },
    ]
    return [...actions, ...taskCmds]
  }, [tasks, navigate, onClose, onNewTask, onOpenSettings])

  // Hold-ctrl+k cycles; releasing ctrl runs the row — only after a cycle
  // happened (single ctrl+k then release stays in typing mode).
  const heldCycleRef = useRef(false)
  const matchesRef = useRef<Command[]>([])
  const cursorRef = useRef(0)
  useEffect(() => {
    if (!open) {
      heldCycleRef.current = false
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault()
        event.stopPropagation()
        heldCycleRef.current = true
        setCursor((c) =>
          matchesRef.current.length === 0
            ? 0
            : (c + 1) % matchesRef.current.length,
        )
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== "Control" && event.key !== "Meta") return
      if (!heldCycleRef.current) return
      heldCycleRef.current = false
      matchesRef.current[cursorRef.current]?.run()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    window.addEventListener("keyup", onKeyUp, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
      window.removeEventListener("keyup", onKeyUp, { capture: true })
    }
  }, [open])

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

  // Refs for the hold-cycle listeners (registered once per open).
  matchesRef.current = matches
  cursorRef.current = cursor

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
        ref={dialogRef}
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
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {matches.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">
              No matches for “{query}”.
            </div>
          ) : (
            matches.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                data-index={index}
                onClick={cmd.run}
                onMouseMove={() => setCursor(index)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
                  index === cursor ? "bg-inset" : "hover:bg-inset/50"
                }`}
              >
                {cmd.taskId ? (
                  // Live engine-activity dot — read here (not in the memo) so
                  // it tracks engine-state pushes without rebuilding the list.
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(
                      engineStates[cmd.taskId]?.state,
                    )}`}
                  />
                ) : (
                  <span
                    className={`shrink-0 ${index === cursor ? "text-primary" : "text-subtle"}`}
                  >
                    <CommandIcon kind={cmd.icon} />
                  </span>
                )}
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
