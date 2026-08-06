/**
 * ChatSidebarTree — the /chat shell's left rail, mirroring the TUI tree
 * sidebar's grammar (SidebarTree.tsx): brand header with the attention INBOX
 * count and [+], Active/Archives view tabs, the Kanban/Routines nav rail,
 * then project → worktree → engine-tab rows with the TUI's state-glyph
 * vocabulary (○ rest, ✱ running, ? permission, ◷ rate-limit, ✕ error,
 * ● unseen turn-complete). Monospace on purpose — the rail should read as
 * the same product as the TUI, just rendered by a browser.
 *
 * Keyboard: the TUI vocabulary via useChatChords (lib/chat-chords.ts) —
 * ctrl+a prefix (HUD chip next to INBOX), prefix+1/2 rail pages,
 * ctrl+2…9,0 row jumps matching the printed digits, j/k/enter cursor,
 * [ / ] view cycle, / focuses search. No new placements — every chord is
 * the TUI's own (docs/KEYBINDINGS.md).
 */

import { Plus } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { taskJumpDigit, useChatChords } from "../lib/chat-chords.ts"
import { useEngines } from "../lib/engines.ts"
import { openNewTask } from "../lib/global-ui.ts"
import { useAppState } from "../lib/store.ts"
import { tabHasPty } from "../lib/tab-kinds.ts"
import {
  addEmptyTab,
  addTab,
  closeTab,
  configureTab,
  setActiveTab,
  useTabsState,
  type WorkspaceTab,
} from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { closePtyTab, fetchPtyForeground } from "../lib/terminal.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { ChatInbox } from "./ChatInbox.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import { EnginePickerModal } from "./EnginePickerModal.tsx"

type View = "active" | "archived"

/** TUI stateGlyph vocabulary (row-view.ts), colored with the web palette. */
function stateGlyph(state: string | undefined): {
  glyph: string
  className: string
  pulse: boolean
} {
  switch (state) {
    case "running":
      return { glyph: "✱", className: "text-kobe-orange", pulse: true }
    case "permission_needed":
    case "waiting_permission":
      return { glyph: "?", className: "text-kobe-yellow", pulse: true }
    case "rate_limited":
      return { glyph: "◷", className: "text-kobe-yellow", pulse: false }
    case "error":
      return { glyph: "✕", className: "text-kobe-red", pulse: false }
    case "turn_complete":
      return { glyph: "●", className: "text-primary", pulse: false }
    default:
      return { glyph: "○", className: "text-subtle", pulse: false }
  }
}

function basename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, "")
  const at = trimmed.lastIndexOf("/")
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

interface ProjectGroup {
  repo: string
  label: string
  tasks: Task[]
}

/** Group tasks under their repo, main checkout first — buildTreeRows' rule. */
export function groupProjects(tasks: readonly Task[]): ProjectGroup[] {
  const byRepo = new Map<string, ProjectGroup>()
  for (const task of tasks) {
    const entry = byRepo.get(task.repo) ?? {
      repo: task.repo,
      label: basename(task.repo),
      tasks: [],
    }
    if (task.kind === "main") entry.tasks.unshift(task)
    else entry.tasks.push(task)
    byRepo.set(task.repo, entry)
  }
  return [...byRepo.values()]
}

function ChangesBadge({
  changes,
}: {
  changes: { added: number; deleted: number } | undefined
}) {
  if (!changes || (changes.added === 0 && changes.deleted === 0)) return null
  return (
    <span className="shrink-0 text-[11px]">
      {changes.added > 0 && (
        <span className="text-kobe-green">+{changes.added}</span>
      )}
      {changes.deleted > 0 && (
        <span className="ml-1 text-kobe-red">−{changes.deleted}</span>
      )}
    </span>
  )
}

/** Dim right-edge jump digit — the TUI's ctrl+digit rail: row 0 prints `2`
 *  (ctrl+1 has no terminal encoding; the web mirrors the printed digits so
 *  the muscle memory transfers verbatim). */
function JumpDigit({ index }: { index: number }) {
  const digit = taskJumpDigit(index)
  if (digit === null) return <span className="w-3 shrink-0" />
  return (
    <span className="w-3 shrink-0 text-right text-[11px] text-subtle/70">
      {digit}
    </span>
  )
}

function WorktreeRow({
  task,
  active,
  cursor,
  changes,
  onClick,
}: {
  task: Task
  active: boolean
  /** The j/k cursor rests here (distinct from active — TUI selection chrome). */
  cursor: boolean
  changes: { added: number; deleted: number; branch?: string } | undefined
  onClick: () => void
}) {
  // Live branch from the worktree.changes channel wins over the stored
  // static task.branch (TUI sidebar grammar).
  const label =
    changes?.branch ||
    task.branch ||
    (task.kind === "main" ? "main" : task.title || "~")
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 border-l-2 py-0.5 pl-2 pr-1 text-left ${
        cursor
          ? "border-primary bg-inset"
          : active
            ? "border-fg/80 bg-menu"
            : "border-transparent hover:bg-inset"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">
        {label}
      </span>
      {task.pinned && (
        <span className="shrink-0 text-[11px] text-kobe-yellow">▴</span>
      )}
      <ChangesBadge changes={changes} />
      {/* Jump digits belong to TAB rows only — spacer keeps the column. */}
      <span className="w-3 shrink-0" />
    </button>
  )
}

function TabRow({
  label,
  engine,
  isEngine,
  jumpIndex,
  active,
  cursor,
  onClick,
}: {
  label: string
  /** Engine activity — only the engine tab carries the state vocabulary;
   *  shell/file tabs wear the plain `·` (TUI owner rule, round 7). */
  engine: EngineState | undefined
  isEngine: boolean
  /** Digit ordinal among TAB rows only (not the global flat index). */
  jumpIndex: number
  active: boolean
  /** The j/k cursor rests here (distinct from active — TUI selection chrome). */
  cursor: boolean
  onClick: () => void
}) {
  const s = isEngine
    ? stateGlyph(engine?.state)
    : { glyph: "·", className: "text-subtle", pulse: false }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 border-l-2 py-0.5 pl-4 pr-1 text-left ${
        cursor
          ? "border-primary bg-inset"
          : active
            ? "border-fg/80 bg-menu"
            : "border-transparent hover:bg-inset"
      }`}
    >
      <span
        className={`w-3 shrink-0 text-[11px] ${s.className} ${s.pulse ? "animate-pulse" : ""}`}
      >
        {s.glyph}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[12px] ${active ? "text-fg" : "text-muted"}`}
      >
        {label}
      </span>
      <JumpDigit index={jumpIndex} />
    </button>
  )
}

/** A task's tree rows: the workspace tab list when it has one (vendor +
 *  terminal tabs, same as the TUI's chattab children), else one implicit
 *  engine row so every worktree still shows its session line. */
function taskTreeTabs(tabs: readonly WorkspaceTab[] | undefined): Array<{
  id: string | null
  key: string
  label: string
  isEngine: boolean
}> {
  const rows = (tabs ?? [])
    .filter((tab) => tab.kind === "vendor" || tab.kind === "terminal")
    .map((tab) => ({
      id: tab.id,
      key: tab.id,
      label: tab.title,
      isEngine: tab.kind === "vendor",
    }))
  return rows.length > 0
    ? rows
    : [{ id: null, key: "__engine", label: "session", isEngine: true }]
}

export function ChatSidebarTree({
  selectedId,
  onSelect,
  surface = "chat",
  onSurfaceChange,
}: {
  selectedId: string | null
  onSelect: (taskId: string) => void
  /** Which main-area surface is showing (chat / embedded Kanban / Routines). */
  surface?: "chat" | "board" | "routines"
  onSurfaceChange?: (surface: "chat" | "board" | "routines") => void
}) {
  const { tasks, engineStates, worktreeChanges, attentionInbox } = useAppState()
  const { tabsByTask, activeByTask } = useTabsState()
  const [view, setView] = useState<View>("active")
  const [query, setQuery] = useState("")
  const [inboxOpen, setInboxOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Foreground trace (TUI live-engine mirror): a tab whose process tree
  // contains an engine binary wears that vendor's state glyphs, not `·`.
  const engines = useEngines()
  const [foreground, setForeground] = useState<Record<string, string[]>>({})
  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      void fetchPtyForeground().then((map) => {
        if (!cancelled) setForeground(map)
      })
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
  const engineTraced = (tabId: string | null): boolean => {
    if (!tabId) return false
    const comms = foreground[tabId]
    if (!comms) return false
    return engines.some((e) => comms.includes(e.id))
  }

  // The durable daemon queue IS the count — same source the panel lists.
  const inbox = attentionInbox.length
  const groups = useMemo(() => {
    const inView = tasks.filter((t) =>
      view === "active" ? !t.archived : t.archived,
    )
    const matched = query.trim()
      ? inView.filter((t) => matchesTask(t, query))
      : inView
    return groupProjects(matched)
  }, [tasks, view, query])

  // The navigable flat row list (worktree + tab rows, project headers
  // excluded — the TUI's treeFlatIds rule). j/k walks every row; jump
  // digits (ctrl+2…9,0) index TAB rows only.
  const flatRows = useMemo(() => {
    const rows: Array<{
      taskId: string
      tabId?: string
      rowKind: "worktree" | "tab"
    }> = []
    for (const group of groups) {
      for (const task of group.tasks) {
        rows.push({ taskId: task.id, rowKind: "worktree" })
        for (const tab of taskTreeTabs(tabsByTask[task.id]))
          rows.push({
            taskId: task.id,
            ...(tab.id ? { tabId: tab.id } : {}),
            rowKind: "tab",
          })
      }
    }
    return rows
  }, [groups, tabsByTask])

  // Digit slots → flatRows indices for TAB rows only (tree order).
  const jumpTargets = useMemo(() => {
    const targets: number[] = []
    for (let i = 0; i < flatRows.length; i++) {
      if (flatRows[i].rowKind === "tab") targets.push(i)
    }
    return targets
  }, [flatRows])

  // Tree cursor (j/k walks it, enter activates). Clamped when the list
  // shrinks; -1 until the first move.
  const [cursor, setCursor] = useState(-1)
  useEffect(() => {
    if (cursor >= flatRows.length) setCursor(Math.max(0, flatRows.length - 1))
  }, [cursor, flatRows.length])

  // Cursor and selection are ONE thread: whenever the selected row changes
  // (click, ctrl+digit, palette), the cursor snaps there so j/k continues
  // from the selection instead of a detached position.
  const selectedFlatIdx = useMemo(() => {
    if (!selectedId) return -1
    const activeId = activeByTask[selectedId]
    let worktreeIdx = -1
    for (let i = 0; i < flatRows.length; i++) {
      const row = flatRows[i]
      if (row.taskId !== selectedId) continue
      if (row.rowKind === "worktree") {
        if (worktreeIdx < 0) worktreeIdx = i
      } else if (row.tabId && row.tabId === activeId) return i
    }
    return worktreeIdx
  }, [selectedId, activeByTask, flatRows])
  useEffect(() => {
    if (selectedFlatIdx >= 0) setCursor(selectedFlatIdx)
  }, [selectedFlatIdx])

  const activateRow = (row: {
    taskId: string
    tabId?: string
  }): void => {
    onSelect(row.taskId)
    if (row.tabId) setActiveTab(row.taskId, row.tabId)
  }

  const prefixArmed = useChatChords({
    onJumpRow: (slot) => {
      const flatIdx = jumpTargets[slot]
      if (flatIdx === undefined) return
      const row = flatRows[flatIdx]
      if (!row) return
      setCursor(flatIdx)
      activateRow(row)
    },
    onCursorMove: (delta) => {
      // The inbox / engine-picker modals own j/k/enter while open.
      if (inboxOpen || pickerOpen) return
      if (flatRows.length === 0) return
      setCursor((cur) => {
        const next = cur < 0 ? 0 : cur + delta
        return Math.min(flatRows.length - 1, Math.max(0, next))
      })
    },
    onCursorActivate: () => {
      if (inboxOpen || pickerOpen) return
      const row = flatRows[cursor]
      if (row) activateRow(row)
    },
    onCycleView: () =>
      setView((cur) => (cur === "active" ? "archived" : "active")),
    onFocusSearch: () => searchRef.current?.focus(),
    onRailPage: (index) =>
      onSurfaceChange?.(index === 0 ? "board" : "routines"),
    onOpenInbox: () => setInboxOpen((cur) => !cur),
    onNewTab: () => {
      if (selectedId) addTab(selectedId)
      else openNewTask()
    },
    onChooseEngine: () => {
      if (selectedId) setPickerOpen(true)
      else openNewTask()
    },
    onCloseTab: () => {
      if (!selectedId) return
      const activeId = activeByTask[selectedId]
      const tab = (tabsByTask[selectedId] ?? []).find((t) => t.id === activeId)
      if (!tab) return
      closeTab(selectedId, tab.id)
      if (tabHasPty(tab.kind)) void closePtyTab(tab.id)
    },
  })

  // One flat index across worktree + tab rows — must mint the same order
  // flatRows was built in (project → worktree → tabs). jumpOrdinal counts
  // TAB rows only (the printed digit slots).
  let flatIndex = -1
  let jumpOrdinal = -1
  const nextIndex = (): number => {
    flatIndex += 1
    return flatIndex
  }
  const nextJumpIndex = (): number => {
    jumpOrdinal += 1
    return jumpOrdinal
  }

  return (
    <aside className="relative flex w-64 shrink-0 flex-col border-r border-line bg-surface font-mono">
      {inboxOpen && (
        <ChatInbox
          selectedId={selectedId}
          onJump={(taskId) => onSelect(taskId)}
          onClose={() => setInboxOpen(false)}
        />
      )}
      {pickerOpen && selectedId && (
        <EnginePickerModal
          onPick={(vendor) => {
            addTab(selectedId, undefined, vendor)
            setPickerOpen(false)
          }}
          onPickShell={() => {
            const id = addEmptyTab(selectedId)
            configureTab(selectedId, id, "terminal")
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div
        data-kobe-topbar
        className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3"
      >
        <DesktopWindowControls />
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-primary">KOBE</span>
          <button
            type="button"
            onClick={() => setInboxOpen((cur) => !cur)}
            className={`text-[12px] font-bold transition-colors hover:text-fg ${
              inbox > 0 ? "text-kobe-yellow" : "text-subtle"
            }`}
            title="Attention inbox (ctrl+a i)"
          >
            INBOX {inbox}
          </button>
          {prefixArmed && (
            <span className="bg-primary px-1 text-[11px] font-bold text-bg">
              ^A
            </span>
          )}
          <button
            type="button"
            onClick={openNewTask}
            className="ml-auto flex items-center text-[13px] font-bold text-primary hover:text-primary-hover"
            title="New task"
            aria-label="New task"
          >
            [<Plus size={11} strokeWidth={3} />]
          </button>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={() => setView("active")}
            className={`px-2 py-0.5 ${
              view === "active"
                ? "bg-primary text-bg"
                : "text-subtle hover:text-fg"
            }`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setView("archived")}
            className={`px-2 py-0.5 ${
              view === "archived"
                ? "bg-primary text-bg"
                : "text-subtle hover:text-fg"
            }`}
          >
            Archives
          </button>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 px-3 pb-2 text-[12px] text-muted">
        <button
          type="button"
          onClick={() => onSurfaceChange?.("board")}
          className={`w-fit hover:text-fg ${surface === "board" ? "text-primary" : ""}`}
        >
          Kanban
        </button>
        <button
          type="button"
          onClick={() => onSurfaceChange?.("routines")}
          className={`w-fit hover:text-fg ${surface === "routines" ? "text-primary" : ""}`}
        >
          Routines
        </button>
      </div>
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("")
            event.currentTarget.blur()
          }
        }}
        placeholder="/ search"
        spellCheck={false}
        className="mx-3 mb-1 shrink-0 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-subtle">
            {view === "archived" ? "No archives." : "No tasks yet — [+]"}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.repo} className="mt-2">
              <div className="flex items-center gap-2 px-3 pb-0.5">
                <span className="shrink-0 text-[12px] font-bold text-muted">
                  {group.label}
                </span>
                <span className="h-px min-w-0 flex-1 bg-line" />
              </div>
              {group.tasks.map((task) => {
                const worktreeIndex = nextIndex()
                return (
                  <div key={task.id}>
                    <WorktreeRow
                      task={task}
                      active={false}
                      cursor={cursor === worktreeIndex}
                      changes={
                        task.worktreePath
                          ? worktreeChanges[task.worktreePath]
                          : undefined
                      }
                      onClick={() => onSelect(task.id)}
                    />
                    {taskTreeTabs(tabsByTask[task.id]).map((tab) => {
                      const tabIndex = nextIndex()
                      const jumpIndex = nextJumpIndex()
                      return (
                        <TabRow
                          key={tab.key}
                          label={tab.label}
                          engine={engineStates[task.id]}
                          isEngine={tab.isEngine || engineTraced(tab.id)}
                          jumpIndex={jumpIndex}
                          active={
                            task.id === selectedId &&
                            (tab.id
                              ? activeByTask[task.id] === tab.id
                              : tab.isEngine)
                          }
                          cursor={cursor === tabIndex}
                          onClick={() => {
                            onSelect(task.id)
                            if (tab.id) setActiveTab(task.id, tab.id)
                          }}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
