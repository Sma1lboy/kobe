import { useNavigate } from "@tanstack/react-router"
import {
  ArrowRight,
  Columns3,
  LayoutPanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { activityColor } from "../lib/activity.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { orderTasksForPalette } from "../lib/palette-commands.ts"
import { useAppState } from "../lib/store.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"
import { reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

interface Command {
  id: string
  label: string
  hint?: string
  icon: "task" | "new" | "settings" | "board" | "workspace"
  taskId?: string
  run: () => void
}

function CommandIcon({ kind }: { kind: Command["icon"] }) {
  if (kind === "new") return <Plus size={14} strokeWidth={2} />
  if (kind === "settings") return <SettingsIcon size={14} strokeWidth={1.8} />
  if (kind === "board") return <Columns3 size={14} strokeWidth={1.8} />
  if (kind === "workspace")
    return <LayoutPanelLeft size={14} strokeWidth={1.8} />
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
  const { selectedTaskId } = useTabsState()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, open)

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  useEffect(() => {
    if (open) {
      setQuery("")
      setCursor(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
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
          void navigate({ to: "/task/$taskId", params: { taskId: t.id } })
          onClose()
        },
      }),
    )
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
        label: "Open board",
        hint: "kanban",
        icon: "board",
        run: () => {
          void navigate({ to: "/board" })
          onClose()
        },
      },
      {
        id: "action:workspace",
        label: "Open workspace",
        hint: "workspace",
        icon: "workspace",
        run: () => {
          if (selectedTaskId) {
            void navigate({
              to: "/task/$taskId",
              params: { taskId: selectedTaskId },
            })
          } else {
            void navigate({ to: "/" })
          }
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
  }, [tasks, selectedTaskId, navigate, onClose, onNewTask, onOpenSettings])

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
