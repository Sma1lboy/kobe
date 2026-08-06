import { Brain, FilePenLine, MessageSquare, TerminalSquare } from "lucide-react"
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
  if (item.kind === "thought") return "Thought"
  if (item.kind === "reasoning") return "Reason"
  if (item.kind === "change") return "Change"
  if (item.kind === "response") return "Result"
  return "Tool"
}

function ItemIcon({ item }: { item: TimelineItem }) {
  const props = { size: 12, strokeWidth: 1.8 }
  if (item.kind === "thought" || item.kind === "reasoning")
    return <Brain {...props} />
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

function ExecutionNode({
  item,
  now,
  main = false,
}: {
  item: TimelineItem
  now: number
  main?: boolean
}) {
  return (
    <article
      className={`execution-node relative z-10 flex min-h-24 min-w-0 flex-col border bg-surface p-2.5 ${main ? "execution-node--main" : "execution-node--branch"} ${statusClasses(item.status)}`}
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
      <div
        className={`mt-2 text-[11px] font-medium leading-[1.45] text-fg ${main ? "line-clamp-4" : "line-clamp-2"}`}
      >
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
  className = "",
}: {
  items: readonly TimelineItem[]
  status: TimelineStatus
  now: number
  className?: string
}) {
  const showWaiting = items.length === 0 && status !== "success"
  const byId = new Map(items.map((item) => [item.id, item]))
  const children = new Map<string, TimelineItem[]>()
  for (const item of items) {
    if (!item.parentId || !byId.has(item.parentId)) continue
    const branch = children.get(item.parentId) ?? []
    branch.push(item)
    children.set(item.parentId, branch)
  }
  const roots = items.filter(
    (item) => !item.parentId || !byId.has(item.parentId),
  )
  return (
    <div
      className={`execution-node-grid relative flex flex-col gap-3 ${className}`}
    >
      {roots.map((item) => {
        const branch = children.get(item.id) ?? []
        return (
          <div key={item.id} className="execution-branch relative">
            <ExecutionNode item={item} now={now} main />
            {branch.length > 0 && (
              <>
                <span
                  className="execution-branch__connector"
                  aria-hidden="true"
                />
                <div className="execution-branch__children relative">
                  {branch.map((child) => (
                    <div
                      key={child.id}
                      className="execution-branch__child relative"
                    >
                      <ExecutionNode item={child} now={now} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
      {showWaiting && (
        <div>
          <WaitingNode status={status} />
        </div>
      )}
    </div>
  )
}
