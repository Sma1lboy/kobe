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
  Bell,
  Columns3,
  LayoutGrid,
  Palette,
  Plus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { attentionTaskIds, nextAttentionTaskId } from "../lib/attention-nav.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { themeCommandEntries } from "../lib/palette-commands.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import {
  clearPreferredTheme,
  setPreferredTheme,
  useThemeState,
} from "../lib/theme.ts"
import { reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

interface Command {
  id: string
  label: string
  hint?: string
  icon:
    | "task"
    | "new"
    | "settings"
    | "overview"
    | "board"
    | "theme"
    | "attention"
  run: () => void
}

function CommandIcon({ kind }: { kind: Command["icon"] }) {
  if (kind === "new") return <Plus size={14} strokeWidth={2} />
  if (kind === "settings") return <SettingsIcon size={14} strokeWidth={1.8} />
  if (kind === "overview") return <LayoutGrid size={14} strokeWidth={1.8} />
  if (kind === "board") return <Columns3 size={14} strokeWidth={1.8} />
  if (kind === "theme") return <Palette size={14} strokeWidth={1.8} />
  if (kind === "attention") return <Bell size={14} strokeWidth={1.8} />
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
  const { tasks, engineStates, activeTaskId } = useAppState()
  const {
    names: themeNames,
    active: activeTheme,
    overridden: themeOverridden,
  } = useThemeState()
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

  // Waiting set is SNAPSHOTTED at open, not read live: the engine-state
  // channel pushes far more often than the task list, and recomputing the
  // command list on every tick (a) burns work while the always-mounted
  // palette is closed and (b) would toggle the head-of-list attention command
  // mid-session, drifting the keyboard cursor. Snapshotting freezes the list
  // for the open window (a task that starts waiting mid-open shows on reopen).
  const [waitingSnapshot, setWaitingSnapshot] = useState<string[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: tasks/engineStates are read once AT open by design (snapshot semantics); only `open` should re-arm this.
  useEffect(() => {
    if (open) {
      setQuery("")
      setCursor(0)
      setWaitingSnapshot(attentionTaskIds(tasks as Task[], engineStates))
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    // Closed palette renders null anyway — skip the whole build so an
    // engine-state re-render doesn't rebuild the list for a discarded result.
    if (!open) return []
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
    // The attention-loop closer: only offered when a task actually needs you
    // (no point listing a no-op). Jumps to the next waiting task after the
    // active one, cycling — so it walks every waiting task on repeat use.
    // Uses the open-time snapshot so the command's presence is stable while
    // the palette is open.
    const waiting = waitingSnapshot
    const actions: Command[] = []
    if (waiting.length > 0) {
      actions.push({
        id: "action:next-attention",
        label: "Go to next task needing you",
        hint: waiting.length > 1 ? `${waiting.length} waiting` : "1 waiting",
        icon: "attention",
        run: () => {
          const next = nextAttentionTaskId(waiting, activeTaskId)
          if (next) {
            selectTask(next)
            void rpc("task.setActive", { taskId: next }).catch((err) =>
              reportError("switch task", err),
            )
            void navigate({ to: "/task/$taskId", params: { taskId: next } })
          }
          onClose()
        },
      })
    }
    actions.push(
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
        id: "action:settings",
        label: "Open settings",
        hint: "settings",
        icon: "settings",
        run: () => {
          onOpenSettings()
          onClose()
        },
      },
    )
    const themeCmds: Command[] = themeCommandEntries(
      themeNames,
      activeTheme,
    ).map((e) => ({
      id: e.id,
      label: e.label,
      hint: e.hint,
      icon: "theme" as const,
      run: () => {
        setPreferredTheme(e.name)
        onClose()
      },
    }))
    // Only offer "Follow TUI" when a web-local override is active — it's the
    // way back from a palette/Settings theme pick to tracking the TUI.
    if (themeOverridden) {
      themeCmds.unshift({
        id: "theme:follow-tui",
        label: "Theme: Follow TUI",
        hint: "clear override",
        icon: "theme",
        run: () => {
          clearPreferredTheme()
          onClose()
        },
      })
    }
    return [...actions, ...themeCmds, ...taskCmds]
  }, [
    open,
    tasks,
    waitingSnapshot,
    activeTaskId,
    themeNames,
    activeTheme,
    themeOverridden,
    navigate,
    onClose,
    onNewTask,
    onOpenSettings,
  ])

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
