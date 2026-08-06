import { ChevronsRight, GitBranch, Maximize2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  durationMs,
  type TimelineModel,
  type TimelineStatus,
} from "../lib/timeline.ts"
import { ExecutionGrid, formatExecutionDuration } from "./ExecutionGrid.tsx"

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

function clockLabel(ms: number): string {
  if (ms <= 0) return ""
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
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
  const hasRunning = model.turns.some((turn) => turn.status === "running")
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

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
    <aside className="flex basis-80 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <GitBranch size={13} strokeWidth={1.8} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Execution map
          </div>
          <div className="truncate font-mono text-[9px] text-subtle">
            {engineLabel} · {summary}
          </div>
        </div>
        <button
          type="button"
          onClick={onExpand}
          className="grid size-6 place-items-center border border-line text-subtle transition-colors hover:border-line-active hover:text-fg"
          aria-label="Expand execution map"
          title="Open execution map"
        >
          <Maximize2 size={11} />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="grid size-6 place-items-center text-subtle hover:text-fg"
          aria-label="Collapse execution map"
          title="Collapse execution map"
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
            Execution map unavailable
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
          <div className="flex flex-col gap-4">
            {model.turns.map((turn, turnIndex) => (
              <section key={turn.id} className="relative">
                <div className="mb-2 flex items-start gap-2 border-b border-line-subtle pb-2">
                  <span className="mt-0.5 font-mono text-[8px] font-bold tracking-[0.14em] text-primary">
                    T{String(turnIndex + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[11px] font-medium leading-[1.35] text-fg">
                      {turn.title}
                    </div>
                    <div className="mt-1 flex gap-2 font-mono text-[8px] text-subtle">
                      <span>{clockLabel(turn.startedAt)}</span>
                      <span>
                        {formatExecutionDuration(
                          durationMs(turn.startedAt, turn.endedAt, now),
                        )}
                      </span>
                      <span>{turn.items.length} blocks</span>
                    </div>
                  </div>
                  <span
                    className={`font-mono text-[9px] ${statusColor(turn.status)}`}
                    title={turn.status}
                  >
                    {statusGlyph(turn.status)}
                  </span>
                </div>
                <ExecutionGrid
                  items={turn.items}
                  status={turn.status}
                  now={now}
                  columns={2}
                />
              </section>
            ))}
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
