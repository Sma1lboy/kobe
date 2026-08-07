import {
  Bot,
  Brain,
  FilePenLine,
  Layers3,
  MessageSquare,
  Quote,
  TerminalSquare,
} from "lucide-react"
import { useState } from "react"
import {
  durationMs,
  type TimelineItem,
  type TimelineStatus,
} from "../lib/timeline.ts"
import { quoteTraceItem } from "../lib/trace-content.ts"
import { ReadableTraceContent } from "./ReadableTraceContent.tsx"
import { SlideOver } from "./SlideOver.tsx"
import { TracePatch } from "./TracePatch.tsx"

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
  // Settled steps recede: only unfinished/failed cards spend a status colour.
  return "border-line-subtle text-muted"
}

function kindLabel(item: TimelineItem): string {
  if (item.kind === "commentary") return "Commentary"
  if (item.kind === "reasoning") return "Reason"
  if (item.kind === "change") return "Change"
  if (item.kind === "answer") return "Result"
  if (item.kind === "subagent") return "Subagent"
  if (item.kind === "compaction") return "Compact"
  return "Tool"
}

function ItemIcon({ item }: { item: TimelineItem }) {
  const props = { size: 12, strokeWidth: 1.8 }
  if (item.kind === "commentary" || item.kind === "reasoning")
    return <Brain {...props} />
  if (item.kind === "change") return <FilePenLine {...props} />
  if (item.kind === "answer") return <MessageSquare {...props} />
  if (item.kind === "subagent") return <Bot {...props} />
  if (item.kind === "compaction") return <Layers3 {...props} />
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
  onOpen,
}: {
  item: TimelineItem
  now: number
  main?: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`execution-node relative z-10 flex min-h-24 w-full min-w-0 flex-col border bg-surface p-2.5 text-left focus-visible:border-primary focus-visible:outline-none ${main ? "execution-node--main" : "execution-node--branch"} ${statusClasses(item.status)}`}
      title={item.summary || item.title}
      aria-label={`Open ${kindLabel(item)} details: ${item.title}`}
    >
      <div className="flex items-center gap-1.5">
        <ItemIcon item={item} />
        <span className="text-[10px] text-current">{kindLabel(item)}</span>
        {(item.attempt ?? 1) > 1 && (
          <span className="font-mono text-[9px] text-subtle">
            A{item.attempt}
          </span>
        )}
        {item.status !== "success" && (
          <span className="ml-auto font-mono text-[9px] text-current">
            {statusGlyph(item.status)}
          </span>
        )}
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
    </button>
  )
}

function ExecutionDetail({
  item,
  parent,
  retryOf,
  now,
  onQuote,
  onClose,
}: {
  item: TimelineItem | undefined
  parent: TimelineItem | undefined
  retryOf: TimelineItem | undefined
  now: number
  onQuote?: (text: string) => Promise<void>
  onClose: () => void
}) {
  const isTool = item?.kind === "tool" || item?.kind === "change"
  const hasResult = isTool || item?.kind === "subagent"
  const [quoting, setQuoting] = useState(false)
  return (
    <SlideOver
      open={item !== undefined}
      onClose={onClose}
      layer="above-modal"
      title={
        item ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] text-primary">
              {kindLabel(item)}
            </span>
            <span className="truncate">{item.title}</span>
          </span>
        ) : undefined
      }
    >
      {item && (
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3 border-b border-line pb-3 font-mono text-[9px] text-subtle">
            <span className={statusClasses(item.status).split(" ").at(-1)}>
              {statusGlyph(item.status)} {item.status}
            </span>
            <span>
              {formatExecutionDuration(
                durationMs(item.startedAt, item.endedAt, now),
              )}
            </span>
            {(item.attempt ?? 1) > 1 && (
              <span className="rounded-full border border-line px-1.5 py-0.5 text-muted">
                attempt {item.attempt}
              </span>
            )}
            {onQuote && (
              <button
                type="button"
                disabled={quoting}
                onClick={() => {
                  setQuoting(true)
                  void onQuote(quoteTraceItem(item))
                    .then(onClose)
                    .catch(() => {})
                    .finally(() => setQuoting(false))
                }}
                className="ml-auto flex items-center gap-1.5 rounded-sm border border-line px-2 py-1 font-sans text-[10px] text-muted transition-colors hover:border-primary hover:text-fg disabled:opacity-50"
                title="Insert this block into the current prompt without sending"
              >
                <Quote size={11} strokeWidth={1.8} />
                {quoting ? "Quoting…" : "Quote to input"}
              </button>
            )}
          </div>
          {retryOf && (
            <section className="rounded-r border-l-2 border-kobe-yellow bg-surface px-3 py-2">
              <div className="text-[11px] text-kobe-yellow">
                Engine-declared retry
              </div>
              <div className="mt-1 text-[11px] text-muted">
                Retrying {retryOf.title}
              </div>
            </section>
          )}
          {parent && (
            <section>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-subtle">
                <span>
                  {item.parentBasis === "explicit"
                    ? "Triggered by"
                    : "Observed after"}
                </span>
                <span className="text-[10px] text-subtle/70">
                  {item.parentBasis === "explicit"
                    ? "source link"
                    : "temporal link"}
                </span>
              </div>
              <div
                className={`rounded-r border-l-2 bg-surface px-3 py-2 text-[11px] leading-relaxed text-muted ${item.parentBasis === "explicit" ? "border-primary" : "border-line-active border-dashed"}`}
              >
                {parent.detail}
              </div>
            </section>
          )}
          {item.kind === "change" ? (
            <TracePatch patch={item.detail} />
          ) : (
            <ReadableTraceContent
              label={
                item.kind === "tool"
                  ? "Input"
                  : item.kind === "answer"
                    ? "Final answer"
                    : item.kind === "reasoning"
                      ? "Reasoning summary"
                      : item.kind === "subagent"
                        ? "Subagent identity"
                        : item.kind === "compaction"
                          ? "Compaction event"
                          : "Visible commentary"
              }
              text={item.detail}
            />
          )}
          {hasResult && (
            <ReadableTraceContent
              label={item.kind === "subagent" ? "Subagent result" : "Result"}
              text={item.resultDetail ?? "No result recorded yet."}
            />
          )}
        </div>
      )}
    </SlideOver>
  )
}

function WaitingNode({ status }: { status: TimelineStatus }) {
  const label = status === "blocked" ? "Waiting for input" : "Awaiting event"
  return (
    <article
      className={`execution-node execution-node--running relative z-10 flex min-h-24 flex-col justify-between border bg-surface p-2.5 ${statusClasses(status)}`}
    >
      <div className="flex items-center gap-1.5 text-[10px]">
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
  onQuote,
  className = "",
}: {
  items: readonly TimelineItem[]
  status: TimelineStatus
  now: number
  onQuote?: (text: string) => Promise<void>
  className?: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const showWaiting = items.length === 0 && status !== "success"
  const byId = new Map(items.map((item) => [item.id, item]))
  const selected = selectedId ? byId.get(selectedId) : undefined
  const parent = selected?.parentId ? byId.get(selected.parentId) : undefined
  const retryOf = selected?.retryOf ? byId.get(selected.retryOf) : undefined
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
    <>
      <div
        className={`execution-node-grid relative flex flex-col gap-3 ${className}`}
      >
        {roots.map((item) => {
          const branch = children.get(item.id) ?? []
          const temporalBranch =
            branch.length > 0 &&
            branch.every((child) => child.parentBasis === "temporal")
          return (
            <div
              key={item.id}
              className={`execution-branch relative ${temporalBranch ? "execution-branch--temporal" : ""}`}
            >
              <ExecutionNode
                item={item}
                now={now}
                main
                onOpen={() => setSelectedId(item.id)}
              />
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
                        className={`execution-branch__child relative ${child.parentBasis === "temporal" ? "execution-branch__child--temporal" : ""}`}
                      >
                        <ExecutionNode
                          item={child}
                          now={now}
                          onOpen={() => setSelectedId(child.id)}
                        />
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
      <ExecutionDetail
        item={selected}
        parent={parent}
        retryOf={retryOf}
        now={now}
        onQuote={onQuote}
        onClose={() => setSelectedId(null)}
      />
    </>
  )
}
