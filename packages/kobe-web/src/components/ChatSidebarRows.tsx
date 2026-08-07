import { taskJumpDigit } from "../lib/chat-chords.ts"
import type { WorkspaceTab } from "../lib/tabs.ts"
import type { EngineState, Task } from "../lib/types.ts"

/** TUI stateGlyph vocabulary (row-view.ts), colored with the web palette. */
function stateGlyph(
  state: string | undefined,
  completionSeen = false,
): {
  glyph: string
  className: string
  pulse: boolean
} {
  if (state === "turn_complete" && completionSeen) {
    return { glyph: "○", className: "text-subtle", pulse: false }
  }
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

export interface ProjectGroup {
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

/** Dim right-edge jump digit — the TUI's ctrl+digit rail. */
function JumpDigit({ index }: { index: number }) {
  const digit = taskJumpDigit(index)
  if (digit === null) return <span className="w-3 shrink-0" />
  return (
    <span className="w-3 shrink-0 text-right text-[11px] text-subtle/30 transition-colors group-hover:text-subtle group-data-[on=true]:text-subtle">
      {digit}
    </span>
  )
}

export function WorktreeRow({
  task,
  active,
  cursor,
  changes,
  onClick,
}: {
  task: Task
  active: boolean
  cursor: boolean
  changes: { added: number; deleted: number; branch?: string } | undefined
  onClick: () => void
}) {
  const label =
    changes?.branch ||
    task.branch ||
    (task.kind === "main" ? "main" : task.title || "~")
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-1.5 rounded-md py-0.5 pl-2.5 pr-1.5 text-left transition-colors ${
        cursor ? "bg-inset" : active ? "bg-menu" : "hover:bg-inset/60"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">
        {label}
      </span>
      {task.pinned && (
        <span className="shrink-0 text-[11px] text-kobe-yellow">▴</span>
      )}
      <ChangesBadge changes={changes} />
      <span className="w-3 shrink-0" />
    </button>
  )
}

export function TabRow({
  label,
  engine,
  isEngine,
  completionSeen,
  jumpIndex,
  active,
  cursor,
  onClick,
}: {
  label: string
  engine: EngineState | undefined
  isEngine: boolean
  completionSeen?: boolean
  jumpIndex: number
  active: boolean
  cursor: boolean
  onClick: () => void
}) {
  const s = isEngine
    ? stateGlyph(engine?.state, completionSeen)
    : { glyph: "·", className: "text-subtle", pulse: false }
  return (
    <button
      type="button"
      onClick={onClick}
      data-on={cursor || active}
      className={`group flex w-full items-center gap-1.5 rounded-md py-0.5 pl-4 pr-1.5 text-left transition-colors ${
        cursor ? "bg-inset" : active ? "bg-menu" : "hover:bg-inset/60"
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

/** A task's workspace tab list, or one implicit engine row when empty. */
export function taskTreeTabs(
  tabs: readonly WorkspaceTab[] | undefined,
): Array<{
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
