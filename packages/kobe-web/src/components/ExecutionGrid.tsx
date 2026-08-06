import { Brain, FilePenLine, MessageSquare, TerminalSquare } from "lucide-react"
import { useId } from "react"
import {
  durationMs,
  type TimelineItem,
  type TimelineStatus,
} from "../lib/timeline.ts"

function statusGlyph(status: TimelineStatus): string {
  if (status === "running") return "●"
  if (status === "error") return "×"
  if (status === "blocked") return "!"
  return "✓"
}

function statusClasses(status: TimelineStatus): string {
  if (status === "running")
    return "execution-node--running border-kobe-blue/60 text-kobe-blue"
  if (status === "error") return "border-kobe-red/70 text-kobe-red"
  if (status === "blocked") return "border-kobe-yellow/70 text-kobe-yellow"
  return "border-line-active text-kobe-green"
}

function kindLabel(item: TimelineItem): string {
  if (item.kind === "reasoning") return "Reason"
  if (item.kind === "change") return "Change"
  if (item.kind === "response") return "Result"
  return "Tool"
}

function ItemIcon({ item }: { item: TimelineItem }) {
  const props = { size: 12, strokeWidth: 1.8 }
  if (item.kind === "reasoning") return <Brain {...props} />
  if (item.kind === "change") return <FilePenLine {...props} />
  if (item.kind === "response") return <MessageSquare {...props} />
  return <TerminalSquare {...props} />
}

export function formatExecutionDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

function gridPosition(index: number, columns: number) {
  const row = Math.floor(index / columns)
  const offset = index % columns
  const column = row % 2 === 0 ? offset : columns - offset - 1
  return { column, row }
}

function tracePath(count: number, columns: number): string {
  return Array.from({ length: count }, (_, index) => {
    const { column, row } = gridPosition(index, columns)
    return `${index === 0 ? "M" : "L"} ${column + 0.5} ${row + 0.5}`
  }).join(" ")
}

function ExecutionTrace({
  count,
  columns,
}: {
  count: number
  columns: number
}) {
  const markerId = `execution-arrow-${useId().replaceAll(":", "")}`
  if (count < 2) return null
  const rows = Math.ceil(count / columns)
  return (
    <svg
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      viewBox={`0 0 ${columns} ${rows}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="5"
          markerHeight="5"
          refX="4"
          refY="2.5"
          orient="auto"
        >
          <path d="M0,0 L5,2.5 L0,5" fill="none" stroke="currentColor" />
        </marker>
      </defs>
      <path
        d={tracePath(count, columns)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        markerEnd={`url(#${markerId})`}
        className="text-line-active"
      />
    </svg>
  )
}

function ExecutionNode({ item, now }: { item: TimelineItem; now: number }) {
  return (
    <article
      className={`execution-node relative z-10 flex min-h-24 min-w-0 flex-col border bg-surface p-2.5 ${statusClasses(item.status)}`}
      title={item.summary || item.title}
    >
      <div className="flex items-center gap-1.5">
        <ItemIcon item={item} />
        <span className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-current">
          {kindLabel(item)}
        </span>
        <span className="ml-auto font-mono text-[9px] text-current">
          {statusGlyph(item.status)}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 text-[11px] font-medium leading-[1.35] text-fg">
        {item.title}
      </div>
      {item.summary && (
        <div className="mt-1 truncate font-mono text-[9px] text-subtle">
          {item.summary}
        </div>
      )}
      <div className="mt-auto pt-2 font-mono text-[8px] text-subtle">
        {formatExecutionDuration(durationMs(item.startedAt, item.endedAt, now))}
      </div>
    </article>
  )
}

function WaitingNode({ status }: { status: TimelineStatus }) {
  const label = status === "blocked" ? "Waiting for input" : "Awaiting event"
  return (
    <article
      className={`execution-node execution-node--running relative z-10 flex min-h-24 flex-col justify-between border bg-surface p-2.5 ${statusClasses(status)}`}
    >
      <div className="flex items-center gap-1.5 font-mono text-[8px] font-bold uppercase tracking-[0.14em]">
        <TerminalSquare size={12} strokeWidth={1.8} />
        Live
        <span className="ml-auto">{statusGlyph(status)}</span>
      </div>
      <div className="text-[11px] font-medium text-fg">{label}</div>
      <div className="font-mono text-[8px] text-subtle">PTY active</div>
    </article>
  )
}

export function ExecutionGrid({
  items,
  status,
  now,
  columns,
  className = "",
}: {
  items: readonly TimelineItem[]
  status: TimelineStatus
  now: number
  columns: number
  className?: string
}) {
  const showWaiting = items.length === 0 && status !== "success"
  const count = items.length + (showWaiting ? 1 : 0)
  return (
    <div
      className={`execution-node-grid relative grid gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      <ExecutionTrace count={count} columns={columns} />
      {items.map((item, index) => {
        const { column, row } = gridPosition(index, columns)
        return (
          <div
            key={item.id}
            style={{ gridColumn: column + 1, gridRow: row + 1 }}
          >
            <ExecutionNode item={item} now={now} />
          </div>
        )
      })}
      {showWaiting && (
        <div style={{ gridColumn: 1, gridRow: 1 }}>
          <WaitingNode status={status} />
        </div>
      )}
    </div>
  )
}
