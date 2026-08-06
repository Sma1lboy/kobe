import {
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  GitBranch,
  Maximize2,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  durationMs,
  type TimelineItem,
  type TimelineModel,
  type TimelineStatus,
} from "../lib/timeline.ts"

function statusGlyph(status: TimelineStatus): string {
  if (status === "running") return "●"
  if (status === "error") return "×"
  if (status === "blocked") return "!"
  return "✓"
}

function statusColor(status: TimelineStatus): string {
  if (status === "running") return "text-kobe-blue"
  if (status === "error") return "text-kobe-red"
  if (status === "blocked") return "text-kobe-yellow"
  return "text-kobe-green"
}

function itemMark(item: TimelineItem): string {
  if (item.kind === "reasoning") return "◇"
  if (item.kind === "change") return "◆"
  if (item.kind === "response") return "▸"
  return "$"
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

function clockLabel(ms: number): string {
  if (ms <= 0) return ""
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function TimelineItemRow({ item, now }: { item: TimelineItem; now: number }) {
  return (
    <div className="group/item relative flex min-w-0 gap-2 py-1.5 pl-4 pr-1">
      <span
        className={`absolute -left-[5px] top-[9px] bg-surface font-mono text-[10px] ${statusColor(item.status)}`}
        aria-hidden="true"
      >
        {itemMark(item)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[11px] font-medium text-fg">
            {item.title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[9px] text-subtle">
            {formatDuration(durationMs(item.startedAt, item.endedAt, now))}
          </span>
        </div>
        {item.summary && (
          <div className="mt-0.5 truncate font-mono text-[10px] text-subtle">
            {item.summary}
          </div>
        )}
      </div>
    </div>
  )
}

export function TimelinePanel({
  model,
  loaded,
  error,
  engineLabel,
  onExpand,
  onCollapse,
}: {
  model: TimelineModel
  loaded: boolean
  error: string | null
  engineLabel: string
  onExpand: () => void
  onCollapse: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atLive, setAtLive] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const hasRunning = model.turns.some((turn) => turn.status === "running")
  const [now, setNow] = useState(() => Date.now())
  const latestId = model.turns.at(-1)?.id

  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  useEffect(() => {
    if (!latestId) return
    setExpanded((current) => {
      if (current.has(latestId)) return current
      const next = new Set(current)
      next.add(latestId)
      return next
    })
  }, [latestId])

  // Follow the live tail until the user deliberately scrolls upward.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns are the scroll trigger.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [model.turns])

  const summary = useMemo(() => {
    const items = model.turns.reduce((sum, turn) => sum + turn.items.length, 0)
    const turnLabel = model.turns.length === 1 ? "turn" : "turns"
    const eventLabel = items === 1 ? "event" : "events"
    return `${model.turns.length} ${turnLabel} · ${items} ${eventLabel}`
  }, [model.turns])

  const jumpToLive = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setAtLive(true)
  }

  return (
    <aside className="flex basis-72 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <GitBranch size={13} strokeWidth={1.8} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Timeline
          </div>
          <div className="truncate font-mono text-[9px] text-subtle">
            {engineLabel} · {summary}
          </div>
        </div>
        <button
          type="button"
          onClick={onExpand}
          className="grid size-6 place-items-center border border-line text-subtle transition-colors hover:border-line-active hover:text-fg"
          aria-label="Expand execution timeline"
          title="Open swimlane view"
        >
          <Maximize2 size={11} />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="grid size-6 place-items-center text-subtle hover:text-fg"
          aria-label="Collapse execution timeline"
          title="Collapse timeline"
        >
          <ChevronsRight size={12} />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 28
          stickRef.current = near
          setAtLive(near)
        }}
        className="execution-grid min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {!loaded && model.turns.length === 0 ? (
          <div className="flex items-center gap-2 py-3 font-mono text-[10px] text-subtle">
            <span className="size-1.5 animate-pulse rounded-full bg-kobe-blue" />
            Reading engine events…
          </div>
        ) : error && model.turns.length === 0 ? (
          <div className="border-l-2 border-kobe-red pl-3 text-[11px] leading-relaxed text-muted">
            Timeline unavailable
            <div className="mt-1 font-mono text-[9px] text-subtle">{error}</div>
          </div>
        ) : model.turns.length === 0 ? (
          <div className="py-8 text-center">
            <div className="font-mono text-[11px] text-muted">No turns yet</div>
            <div className="mt-1 text-[10px] text-subtle">
              Execution events appear with the next prompt.
            </div>
          </div>
        ) : (
          <div className="relative">
            <div className="absolute bottom-3 left-[7px] top-3 w-px bg-line-active" />
            {model.turns.map((turn) => {
              const open = expanded.has(turn.id)
              return (
                <section key={turn.id} className="relative pb-3 pl-5">
                  <span
                    className={`absolute left-[2px] top-[10px] z-10 grid size-[11px] place-items-center bg-surface font-mono text-[9px] ${statusColor(turn.status)}`}
                    aria-hidden="true"
                  >
                    {statusGlyph(turn.status)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(turn.id)) next.delete(turn.id)
                        else next.add(turn.id)
                        return next
                      })
                    }
                    className="flex w-full items-start gap-1.5 py-1 text-left"
                    aria-expanded={open}
                  >
                    <span className="mt-0.5 text-subtle">
                      {open ? (
                        <ChevronDown size={11} />
                      ) : (
                        <ChevronRight size={11} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium leading-relaxed text-fg">
                        {turn.title}
                      </span>
                      <span className="mt-0.5 flex gap-2 font-mono text-[9px] text-subtle">
                        <span>{clockLabel(turn.startedAt)}</span>
                        <span>
                          {formatDuration(
                            durationMs(turn.startedAt, turn.endedAt, now),
                          )}
                        </span>
                        <span>{turn.items.length} events</span>
                      </span>
                    </span>
                  </button>
                  {open && turn.items.length > 0 && (
                    <div className="ml-1.5 mt-1 border-l border-line-active">
                      {turn.items.map((item) => (
                        <TimelineItemRow key={item.id} item={item} now={now} />
                      ))}
                    </div>
                  )}
                  {open &&
                    turn.items.length === 0 &&
                    turn.status === "running" && (
                      <div className="ml-1.5 mt-1 flex items-center gap-2 border-l border-line-active py-2 pl-4 font-mono text-[10px] text-kobe-blue">
                        <span className="size-1.5 animate-pulse rounded-full bg-current" />
                        Waiting for the first event…
                      </div>
                    )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {!atLive && (
        <button
          type="button"
          onClick={jumpToLive}
          className="mx-3 mb-3 flex h-7 items-center justify-center gap-1.5 border border-line bg-bg font-mono text-[10px] text-muted hover:border-primary hover:text-fg"
        >
          <span className="size-1.5 rounded-full bg-kobe-blue" />
          Jump to live
        </button>
      )}
    </aside>
  )
}
