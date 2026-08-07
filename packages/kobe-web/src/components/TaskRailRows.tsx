/**
 * Row/section building blocks of the task rail — split from AppShell.tsx so
 * the shell keeps only the frame (top bar, status bar, region layout).
 */

import { Loader2 } from "lucide-react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import { relativeTime } from "../lib/time.ts"
import type { EngineState, Task, TaskJob } from "../lib/types.ts"
import { ChangesChip, EngineChip, PrChip } from "./chips.tsx"

export function SectionHeader({
  children,
  suffix,
}: {
  children: React.ReactNode
  suffix?: string
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        {children}
      </span>
      {suffix ? (
        <>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] font-bold uppercase text-primary">
            {suffix}
          </span>
        </>
      ) : null}
    </div>
  )
}

export function TaskRow({
  task,
  engine,
  job,
  changes,
  engineName,
  active,
  onClick,
}: {
  task: Task
  engine?: EngineState
  job?: TaskJob
  changes?: { added: number; deleted: number }
  /** Engine label to show (mixed-engine workspaces only); null hides it. */
  engineName: string | null
  active: boolean
  onClick: () => void
}) {
  const materializing = job?.phase === "running"
  const label = materializing ? "materializing…" : activityLabel(engine?.state)
  const updated = relativeTime(task.updatedAt || task.createdAt)
  return (
    <button
      type="button"
      data-task-id={task.id}
      onClick={onClick}
      className={`group w-full border-l-2 px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-inset"
          : "border-transparent hover:bg-surface"
      }`}
    >
      <div className="flex items-center gap-2">
        {materializing ? (
          <Loader2
            size={10}
            strokeWidth={2.5}
            className="shrink-0 animate-spin text-primary"
          />
        ) : (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${active ? "text-fg" : "text-fg/90"}`}
        >
          {task.title || task.branch}
        </span>
        <PrChip pr={task.prStatus} />
        {task.pinned && (
          <span className="shrink-0 text-[10px] text-subtle">PIN</span>
        )}
        <ChangesChip counts={changes} />
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-subtle">
        <span className="min-w-0 truncate">{task.branch || "—"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <EngineChip label={engineName} />
          {label && <span className="text-muted">{label}</span>}
          {updated && <span className="text-subtle">{updated}</span>}
        </span>
      </div>
    </button>
  )
}

export function ArchivedRow({
  task,
  onRestore,
  onPreview,
}: {
  task: Task
  onRestore: () => void
  /** Beta: open the read-only history preview. Absent → title is plain text
   *  (the gate is off), so the row keeps its restore-only behavior. */
  onPreview?: () => void
}) {
  const label = task.title || task.branch
  return (
    <div className="group flex items-center gap-2 border-l-2 border-transparent px-3 py-1.5">
      {onPreview ? (
        <button
          type="button"
          onClick={onPreview}
          title="Preview history"
          className="min-w-0 flex-1 truncate text-left text-[12px] text-subtle transition-colors hover:text-fg"
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={onRestore}
        className="shrink-0 border border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted opacity-0 transition-opacity hover:border-primary hover:text-fg group-hover:opacity-100"
      >
        Restore
      </button>
    </div>
  )
}
