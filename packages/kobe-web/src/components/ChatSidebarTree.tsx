/**
 * ChatSidebarTree — the /chat shell's left rail, mirroring the TUI tree
 * sidebar's grammar (SidebarTree.tsx): brand header with the attention INBOX
 * count and [+], Active/Archives view tabs, the Kanban/Routines nav rail,
 * then project → worktree → engine-tab rows with the TUI's state-glyph
 * vocabulary (○ rest, ✱ running, ? permission, ◷ rate-limit, ✕ error,
 * ● unseen turn-complete). Monospace on purpose — the rail should read as
 * the same product as the TUI, just rendered by a browser.
 *
 * Structure only, no keyboard machinery: rows are buttons, the jump digits
 * are visual parity (the chords stay TUI-side for now).
 */

import { useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { attentionCount } from "../lib/document-title.ts"
import { openNewTask } from "../lib/global-ui.ts"
import { useAppState } from "../lib/store.ts"
import { useTabsState, type WorkspaceTab } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"

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

/** Dim right-edge jump digit — slots 1..9,0 like the TUI's ctrl+digit rail. */
function JumpDigit({ index }: { index: number }) {
  if (index >= 10) return <span className="w-3 shrink-0" />
  return (
    <span className="w-3 shrink-0 text-right text-[11px] text-subtle/70">
      {(index + 1) % 10}
    </span>
  )
}

function WorktreeRow({
  task,
  flatIndex,
  active,
  changes,
  onClick,
}: {
  task: Task
  flatIndex: number
  active: boolean
  changes: { added: number; deleted: number } | undefined
  onClick: () => void
}) {
  const label =
    task.branch || (task.kind === "main" ? "main" : task.title || "~")
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 border-l-2 py-0.5 pl-2 pr-1 text-left ${
        active ? "border-fg/80 bg-menu" : "border-transparent hover:bg-surface"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">
        {label}
      </span>
      {task.pinned && (
        <span className="shrink-0 text-[11px] text-kobe-yellow">▴</span>
      )}
      <ChangesBadge changes={changes} />
      <JumpDigit index={flatIndex} />
    </button>
  )
}

function TabRow({
  label,
  engine,
  isEngine,
  flatIndex,
  active,
  onClick,
}: {
  label: string
  /** Engine activity — only the engine tab carries the state vocabulary;
   *  shell/file tabs wear the plain `·` (TUI owner rule, round 7). */
  engine: EngineState | undefined
  isEngine: boolean
  flatIndex: number
  active: boolean
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
        active ? "border-fg/80 bg-menu" : "border-transparent hover:bg-surface"
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
      <JumpDigit index={flatIndex} />
    </button>
  )
}

/** A task's tree rows: the workspace tab list when it has one (vendor +
 *  terminal tabs, same as the TUI's chattab children), else one implicit
 *  engine row so every worktree still shows its session line. */
function taskTreeTabs(tabs: readonly WorkspaceTab[] | undefined): Array<{
  key: string
  label: string
  isEngine: boolean
}> {
  const rows = (tabs ?? [])
    .filter((tab) => tab.kind === "vendor" || tab.kind === "terminal")
    .map((tab) => ({
      key: tab.id,
      label: tab.title,
      isEngine: tab.kind === "vendor",
    }))
  return rows.length > 0
    ? rows
    : [{ key: "__engine", label: "session", isEngine: true }]
}

export function ChatSidebarTree({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (taskId: string) => void
}) {
  const { tasks, engineStates, worktreeChanges } = useAppState()
  const { tabsByTask } = useTabsState()
  const navigate = useNavigate()
  const [view, setView] = useState<View>("active")
  const [query, setQuery] = useState("")

  const inbox = useMemo(
    () => attentionCount(tasks, engineStates),
    [tasks, engineStates],
  )
  const groups = useMemo(() => {
    const inView = tasks.filter((t) =>
      view === "active" ? !t.archived : t.archived,
    )
    const matched = query.trim()
      ? inView.filter((t) => matchesTask(t, query))
      : inView
    return groupProjects(matched)
  }, [tasks, view, query])

  // One flat index across worktree + tab rows — the jump-digit rail.
  let flatIndex = -1
  const nextIndex = (): number => {
    flatIndex += 1
    return flatIndex
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface font-mono">
      <div
        data-kobe-topbar
        className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3"
      >
        <DesktopWindowControls />
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-primary">KOBE</span>
          <span
            className={`text-[12px] font-bold ${inbox > 0 ? "text-kobe-yellow" : "text-subtle"}`}
          >
            INBOX {inbox}
          </span>
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
          onClick={() => void navigate({ to: "/board" })}
          className="w-fit hover:text-fg"
        >
          Kanban
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: "/issues" })}
          className="w-fit hover:text-fg"
        >
          Routines
        </button>
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
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
                      flatIndex={worktreeIndex}
                      active={false}
                      changes={
                        task.worktreePath
                          ? worktreeChanges[task.worktreePath]
                          : undefined
                      }
                      onClick={() => onSelect(task.id)}
                    />
                    {taskTreeTabs(tabsByTask[task.id]).map((tab) => (
                      <TabRow
                        key={tab.key}
                        label={tab.label}
                        engine={engineStates[task.id]}
                        isEngine={tab.isEngine}
                        flatIndex={nextIndex()}
                        active={task.id === selectedId && tab.isEngine}
                        onClick={() => onSelect(task.id)}
                      />
                    ))}
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
