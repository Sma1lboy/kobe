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

import { CircleHelp, Plus, Settings } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useChatChords } from "../lib/chat-chords.ts"
import { useEngines } from "../lib/engines.ts"
import {
  closeSettings,
  openKeyboardHelp,
  openNewTask,
  openSettings,
} from "../lib/global-ui.ts"
import { useAppState } from "../lib/store.ts"
import { tabHasPty } from "../lib/tab-kinds.ts"
import {
  addEmptyTab,
  addTab,
  closeTab,
  configureTab,
  setActiveTab,
  useTabsState,
} from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { closePtyTab, fetchPtyForeground } from "../lib/terminal.ts"
import {
  groupProjects,
  TabRow,
  taskTreeTabs,
  WorktreeRow,
} from "./ChatSidebarRows.tsx"
import { ChatInbox } from "./ChatInbox.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import { EnginePickerModal } from "./EnginePickerModal.tsx"

type View = "active" | "archived"

/** herdr "seen" bit — the TUI contract verbatim (row-cards.ts
 *  completionSeenFor): keys whose CURRENT turn_complete the user has viewed,
 *  so ● digests away. Session-scoped; cleared when activity moves off
 *  turn_complete. Daemon state is never touched. */
const completionSeenKeys = new Set<string>()
export function completionSeenFor(
  key: string,
  activityState: string | undefined,
  viewing: boolean,
): boolean {
  if (activityState === "turn_complete") {
    if (viewing) completionSeenKeys.add(key)
  } else {
    completionSeenKeys.delete(key)
  }
  return completionSeenKeys.has(key)
}

export { groupProjects } from "./ChatSidebarRows.tsx"

export function ChatSidebarTree({
  selectedId,
  onSelect,
  surface = "chat",
  onSurfaceChange,
  width,
}: {
  selectedId: string | null
  onSelect: (taskId: string) => void
  /** Which main-area surface is showing (chat / embedded Kanban / Routines). */
  surface?: "chat" | "board" | "routines"
  onSurfaceChange?: (surface: "chat" | "board" | "routines") => void
  /** Drag-resized width (PaneResizer) — falls back to the w-64 default. */
  width?: number
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
      closeSettings()
      if (selectedId) addTab(selectedId)
      else openNewTask()
    },
    onChooseEngine: () => {
      closeSettings()
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
    <aside
      className="relative flex w-64 shrink-0 flex-col border-r border-line bg-surface font-mono"
      style={width ? { width } : undefined}
    >
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
            className={`rounded-md px-2 py-0.5 transition-colors ${
              view === "active"
                ? "bg-primary text-bg"
                : "text-subtle hover:bg-inset/60 hover:text-fg"
            }`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setView("archived")}
            className={`rounded-md px-2 py-0.5 transition-colors ${
              view === "archived"
                ? "bg-primary text-bg"
                : "text-subtle hover:bg-inset/60 hover:text-fg"
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
          className={`w-fit transition-colors hover:text-fg ${surface === "board" ? "text-primary" : ""}`}
        >
          Kanban
        </button>
        <button
          type="button"
          onClick={() => onSurfaceChange?.("routines")}
          className={`w-fit transition-colors hover:text-fg ${surface === "routines" ? "text-primary" : ""}`}
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
            <div key={group.repo} className="mt-4 first:mt-2">
              <div className="truncate px-3 pb-1 text-[11px] font-semibold tracking-wide text-subtle">
                {group.label}
              </div>
              {group.tasks.map((task) => {
                const worktreeIndex = nextIndex()
                return (
                  <div key={task.id} className="px-1.5">
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
                      const viewing =
                        task.id === selectedId &&
                        (tab.id
                          ? activeByTask[task.id] === tab.id
                          : tab.isEngine)
                      return (
                        <TabRow
                          key={tab.key}
                          label={tab.label}
                          engine={engineStates[task.id]}
                          isEngine={tab.isEngine || engineTraced(tab.id)}
                          completionSeen={completionSeenFor(
                            `${task.id}:${tab.key}`,
                            engineStates[task.id]?.state,
                            viewing,
                          )}
                          jumpIndex={jumpIndex}
                          active={viewing}
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
      {/* Bottom-left utility rail: settings + keyboard help. */}
      <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-1.5">
        <button
          type="button"
          onClick={openSettings}
          title="Settings"
          aria-label="Settings"
          className="flex h-6 w-6 items-center justify-center rounded text-subtle transition-colors hover:bg-inset hover:text-fg"
        >
          <Settings size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={openKeyboardHelp}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="flex h-6 w-6 items-center justify-center rounded text-subtle transition-colors hover:bg-inset hover:text-fg"
        >
          <CircleHelp size={13} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  )
}
