import { Maximize2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  durationMs,
  type TimelineModel,
  type TimelineStatus,
  type TimelineTurn,
} from "../lib/timeline.ts"
import type { PendingTraceQuote } from "../lib/trace-content.ts"
import type { TimelineBindingState } from "../lib/use-timeline-data.ts"
import { ExecutionGrid, formatExecutionDuration } from "./ExecutionGrid.tsx"

/** Always-visible turn nodes: the RESULT (answer) plus anything not settled
 *  (running / error / blocked). The intermediate tool churn folds away —
 *  readers scan the user prompt + result, and expand on demand. */
function isSpotlightNode(node: TimelineTurn["nodes"][number]): boolean {
  return node.kind === "answer" || node.status !== "success"
}

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

/** A small causal-chain loader: identity → history → normalized events. */
function TraceLoading({ label }: { label: string }) {
  return (
    <output
      aria-live="polite"
      data-testid="trace-loading"
      className="flex items-center gap-3 py-3 font-mono text-[10px] text-subtle"
    >
      <span className="trace-loader" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}</span>
    </output>
  )
}

/** One turn: header (user prompt + meta) and its execution nodes, with the
 *  settled intermediate steps folded behind a count chip by default. */
function TurnSection({
  turn,
  turnIndex,
  now,
  onQuote,
}: {
  turn: TimelineTurn
  turnIndex: number
  now: number
  onQuote?: (quote: PendingTraceQuote) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const spotlight = turn.nodes.filter(isSpotlightNode)
  // Never fold down to nothing mid-turn: keep the latest step visible.
  const visible = spotlight.length > 0 ? spotlight : turn.nodes.slice(-1)
  const foldedCount = turn.nodes.length - visible.length
  const items = expanded ? turn.nodes : visible
  return (
    <section className="relative">
      <div className="mb-1.5 flex items-start gap-2">
        <span className="mt-0.5 font-mono text-[9px] text-primary">
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
            <span>{turn.nodes.length} blocks</span>
          </div>
        </div>
        {turn.status !== "success" && (
          <span
            className={`font-mono text-[9px] ${statusColor(turn.status)}`}
            title={turn.status}
          >
            {statusGlyph(turn.status)}
          </span>
        )}
      </div>
      {foldedCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((cur) => !cur)}
          className="mb-2 flex items-center gap-1.5 font-mono text-[9px] text-subtle transition-colors hover:text-fg"
          aria-expanded={expanded}
        >
          <span>{expanded ? "▾" : "▸"}</span>
          {expanded ? "Hide steps" : `${foldedCount} steps`}
        </button>
      )}
      <ExecutionGrid
        items={items}
        status={turn.status}
        now={now}
        onQuote={onQuote}
      />
    </section>
  )
}

export function TimelinePanel({
  model,
  loaded,
  error,
  engineLabel,
  active = true,
  bindingState,
  runId,
  width,
  onQuote,
  onExpand,
}: {
  model: TimelineModel
  loaded: boolean
  error: string | null
  engineLabel: string
  /** Is an engine live in the active tab? History remains visible when off. */
  active?: boolean
  bindingState: TimelineBindingState
  /** Kobe-owned temporal run; absent only with a v1 daemon. */
  runId?: string
  /** Drag-resized width (PaneResizer) — falls back to the basis-80 default. */
  width?: number
  /** Buffer a trace block beside the active native composer until submit. */
  onQuote?: (quote: PendingTraceQuote) => Promise<void>
  onExpand: () => void
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
    const items = model.turns.reduce((sum, turn) => sum + turn.nodes.length, 0)
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
    <aside
      className="flex basis-80 shrink-0 flex-col border-l border-line bg-surface"
      style={width ? { width, flexBasis: width } : undefined}
    >
      {/* One control here (fullscreen). Open/close lives on the chat
          header's single toggle — no duplicate chrome, no branch icon
          colliding with the REAL git-branch concept in the status bar. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-muted">Agent trace</div>
          <div className="truncate font-mono text-[9px] text-subtle">
            {model.sessionId
              ? `${engineLabel} · ${active ? "live" : "history"}${runId ? ` · run ${runId.slice(0, 8)}` : ""} · ${summary}`
              : `${engineLabel} · ${bindingState}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onExpand}
          className="grid size-6 place-items-center text-subtle transition-colors hover:text-fg"
          aria-label="Expand agent trace"
          title="Open agent trace fullscreen"
        >
          <Maximize2 size={11} />
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
        {bindingState === "unavailable" ? (
          <div className="py-8 text-center">
            <div className="font-mono text-[11px] text-muted">
              Session binding unavailable
            </div>
            <div className="mt-1 text-[10px] text-subtle">
              This daemon has not identified the engine session for this tab.
            </div>
          </div>
        ) : bindingState === "pending" ? (
          <TraceLoading label="Waiting for the engine session id…" />
        ) : bindingState === "empty" ? (
          <div className="py-8 text-center">
            <div className="font-mono text-[11px] text-muted">No turns yet</div>
            <div className="mt-1 text-[10px] text-subtle">
              Execution events appear with the next prompt.
            </div>
          </div>
        ) : bindingState === "missing" ? (
          <div className="border-l-2 border-kobe-yellow pl-3 text-[11px] leading-relaxed text-muted">
            Bound engine session is missing
          </div>
        ) : !loaded && model.turns.length === 0 ? (
          <TraceLoading label="Reading engine events…" />
        ) : error && model.turns.length === 0 ? (
          <div className="border-l-2 border-kobe-red pl-3 text-[11px] leading-relaxed text-muted">
            Agent trace unavailable
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
          <div className="flex flex-col gap-6">
            {model.turns.map((turn, turnIndex) => (
              <TurnSection
                key={turn.id}
                turn={turn}
                turnIndex={turnIndex}
                now={now}
                onQuote={onQuote}
              />
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
