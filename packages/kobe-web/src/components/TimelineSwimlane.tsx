import { GitBranch, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  durationMs,
  type TimelineItem,
  type TimelineItemKind,
  type TimelineModel,
  type TimelineStatus,
} from "../lib/timeline.ts"

type Lane = "reason" | "tools" | "result"

const LANES: readonly { id: Lane; label: string }[] = [
  { id: "reason", label: "Reason" },
  { id: "tools", label: "Tools" },
  { id: "result", label: "Result" },
]

function laneFor(kind: TimelineItemKind): Lane {
  if (kind === "reasoning") return "reason"
  if (kind === "response") return "result"
  return "tools"
}

function statusClass(status: TimelineStatus): string {
  if (status === "running") return "border-kobe-blue text-kobe-blue"
  if (status === "error") return "border-kobe-red text-kobe-red"
  if (status === "blocked") return "border-kobe-yellow text-kobe-yellow"
  return "border-kobe-green/50 text-muted"
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`
}

function LaneItem({ item, now }: { item: TimelineItem; now: number }) {
  return (
    <div
      className={`min-w-36 max-w-72 border-l-2 bg-surface px-2.5 py-1.5 ${statusClass(item.status)}`}
      title={item.summary || item.title}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[11px] font-medium text-fg">
          {item.title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px] text-subtle">
          {formatDuration(durationMs(item.startedAt, item.endedAt, now))}
        </span>
      </div>
      {item.summary && (
        <div className="mt-0.5 truncate font-mono text-[9px] text-subtle">
          {item.summary}
        </div>
      )}
    </div>
  )
}

export function TimelineSwimlane({
  model,
  engineLabel,
  onClose,
}: {
  model: TimelineModel
  engineLabel: string
  onClose: () => void
}) {
  const running = model.turns.some((turn) => turn.status === "running")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-bg"
      role="dialog"
      aria-modal="true"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <div className="grid size-8 place-items-center border border-primary/50 text-primary">
          <GitBranch size={15} strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-fg">
            Execution swimlane
          </h2>
          <div className="font-mono text-[10px] text-subtle">
            {engineLabel} · {model.turns.length}{" "}
            {model.turns.length === 1 ? "turn" : "turns"}
            {model.sessionId ? ` · ${model.sessionId.slice(0, 8)}` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 font-mono text-[10px] text-subtle">
          <span className="size-1.5 rounded-full bg-kobe-blue" />
          Turn-local execution lanes
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-3 grid size-8 place-items-center border border-line text-subtle hover:border-line-active hover:text-fg"
          aria-label="Close execution swimlane"
          title="Close"
        >
          <X size={14} />
        </button>
      </header>

      <div className="execution-grid min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
          {model.turns.length === 0 ? (
            <div className="grid min-h-96 place-items-center font-mono text-[11px] text-subtle">
              No execution events yet.
            </div>
          ) : (
            model.turns.map((turn, turnIndex) => (
              <section key={turn.id} className="border border-line bg-bg/90">
                <div className="flex min-h-11 items-center gap-3 border-b border-line bg-surface px-3">
                  <span className="font-mono text-[9px] font-bold tracking-[0.14em] text-primary">
                    TURN {String(turnIndex + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                    {turn.title}
                  </span>
                  <span
                    className={`font-mono text-[9px] uppercase ${statusClass(turn.status).split(" ")[1]}`}
                  >
                    {turn.status}
                  </span>
                  <span className="font-mono text-[9px] text-subtle">
                    {formatDuration(
                      durationMs(turn.startedAt, turn.endedAt, now),
                    )}
                  </span>
                </div>

                <div className="divide-y divide-line-subtle">
                  {LANES.map((lane) => {
                    const items = turn.items.filter(
                      (item) => laneFor(item.kind) === lane.id,
                    )
                    const liveEmpty =
                      lane.id === "tools" &&
                      turn.status === "running" &&
                      items.length === 0
                    return (
                      <div
                        key={lane.id}
                        className="grid min-h-14 grid-cols-[78px_minmax(0,1fr)]"
                      >
                        <div className="flex items-center border-r border-line bg-surface/70 px-3 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-subtle">
                          {lane.label}
                        </div>
                        <div className="relative flex min-w-0 items-center gap-2 overflow-x-auto px-3 py-2">
                          <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-line-subtle" />
                          {items.map((item) => (
                            <div
                              key={item.id}
                              className="relative z-10 shrink-0"
                            >
                              <LaneItem item={item} now={now} />
                            </div>
                          ))}
                          {liveEmpty && (
                            <div className="relative z-10 flex items-center gap-2 bg-bg px-2 font-mono text-[10px] text-kobe-blue">
                              <span className="size-1.5 animate-pulse rounded-full bg-current" />
                              Waiting for the first event…
                            </div>
                          )}
                          {items.length === 0 && !liveEmpty && (
                            <span className="relative z-10 bg-bg px-2 font-mono text-[9px] text-subtle/60">
                              —
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
